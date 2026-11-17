import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type { McpConformanceReport } from "@nest-mcp/conformance";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import {
	SAFE_DISCOVERY_PLAN_ID,
	type ConformanceRunListView,
	type ConformanceRunTarget,
	type ConformanceRunView,
	isTerminalConformanceRun,
} from "./conformance.types.ts";

const MAX_ACTIVE_RUNS = 4;
const MAX_TERMINAL_RUNS = 100;

@Injectable()
export class ConformanceRunRepository {
	readonly #runs = new Map<string, ConformanceRunView>();
	readonly #terminalRunIds: string[] = [];

	create(target: ConformanceRunTarget): ConformanceRunView {
		if (this.#activeCount() >= MAX_ACTIVE_RUNS) {
			throw new ControlPlaneError(
				"MCP_CONFORMANCE_CAPACITY_EXCEEDED",
				503,
				"The process already has the maximum number of active conformance runs.",
			);
		}
		if (
			[...this.#runs.values()].some(
				(run) =>
					!isTerminalConformanceRun(run.status) &&
					run.target.connectionId === target.connectionId &&
					run.target.runtimeGeneration === target.runtimeGeneration,
			)
		) {
			throw new ControlPlaneError(
				"MCP_CONFORMANCE_ALREADY_ACTIVE",
				409,
				"This MCP runtime generation already has an active conformance run.",
			);
		}

		const run = freezeRun({
			runId: randomUUID(),
			planId: SAFE_DISCOVERY_PLAN_ID,
			target: Object.freeze({ ...target }),
			status: "queued",
			createdAt: new Date().toISOString(),
		});
		this.#runs.set(run.runId, run);
		return run;
	}

	get(runId: string): ConformanceRunView {
		const run = this.#runs.get(runId);
		if (run !== undefined) return run;
		throw new ControlPlaneError(
			"MCP_CONFORMANCE_RUN_NOT_FOUND",
			404,
			"The conformance run does not exist.",
		);
	}

	list(connectionId: string, runtimeGeneration: number, limit: number): ConformanceRunListView {
		const runs = [...this.#runs.values()]
			.filter(
				(run) =>
					run.target.connectionId === connectionId &&
					run.target.runtimeGeneration === runtimeGeneration,
			)
			.toReversed()
			.slice(0, limit);
		return Object.freeze({ runs: Object.freeze(runs) });
	}

	markRunning(runId: string): ConformanceRunView {
		const run = this.get(runId);
		if (run.status !== "queued") return run;
		return this.#replace(
			run,
			freezeRun({ ...run, status: "running", startedAt: new Date().toISOString() }),
		);
	}

	requestCancellation(runId: string): ConformanceRunView {
		const run = this.get(runId);
		if (isTerminalConformanceRun(run.status) || run.status === "cancelling") return run;
		return this.#replace(run, freezeRun({ ...run, status: "cancelling" }));
	}

	complete(runId: string, report: McpConformanceReport): ConformanceRunView {
		const run = this.get(runId);
		const status =
			report.completion === "cancelled"
				? "cancelled"
				: report.completion === "timed-out"
					? "timed-out"
					: "completed";
		return this.#terminal(
			run,
			freezeRun({
				...run,
				status,
				finishedAt: report.finishedAt,
				report,
			}),
		);
	}

	fail(runId: string, errorCode: string): ConformanceRunView {
		const run = this.get(runId);
		return this.#terminal(
			run,
			freezeRun({
				...run,
				status: "failed",
				finishedAt: new Date().toISOString(),
				errorCode,
			}),
		);
	}

	cancelBeforeStart(runId: string): ConformanceRunView {
		const run = this.get(runId);
		return this.#terminal(
			run,
			freezeRun({ ...run, status: "cancelled", finishedAt: new Date().toISOString() }),
		);
	}

	#replace(previous: ConformanceRunView, current: ConformanceRunView): ConformanceRunView {
		if (this.#runs.get(previous.runId) !== previous) return this.get(previous.runId);
		this.#runs.set(current.runId, current);
		return current;
	}

	#terminal(previous: ConformanceRunView, current: ConformanceRunView): ConformanceRunView {
		if (isTerminalConformanceRun(previous.status)) return previous;
		const accepted = this.#replace(previous, current);
		if (accepted !== current) return accepted;
		this.#terminalRunIds.push(current.runId);
		while (this.#terminalRunIds.length > MAX_TERMINAL_RUNS) {
			const expired = this.#terminalRunIds.shift();
			if (expired !== undefined) this.#runs.delete(expired);
		}
		return current;
	}

	#activeCount(): number {
		let count = 0;
		for (const run of this.#runs.values()) {
			if (!isTerminalConformanceRun(run.status)) count += 1;
		}
		return count;
	}
}

function freezeRun(run: ConformanceRunView): ConformanceRunView {
	return Object.freeze(run);
}
