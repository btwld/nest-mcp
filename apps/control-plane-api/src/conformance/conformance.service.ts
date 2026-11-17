import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { MCP_CLIENT_LEASE_INVALIDATED } from "@nest-mcp/client";
import { runMcpConformancePlan } from "@nest-mcp/conformance";
import { MCP_RUNTIME_GENERATION_RETIRED, type McpRuntimeManagerPort } from "@nest-mcp/manager";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { ConnectionRepository } from "../connections/connection.repository.ts";
import type { ConnectionRecord } from "../connections/connection.types.ts";
import { VolatileOAuthAuthorityService } from "../oauth/volatile-oauth-authority.service.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../runtime/runtime.types.ts";
import type { CreateConformanceRunDto } from "./conformance.dto.ts";
import { ConformanceRunRepository } from "./conformance.repository.ts";
import { MCP_CONFORMANCE_SUBJECT } from "./conformance-subject.ts";
import {
	type ConformanceRunListView,
	type ConformanceRunTarget,
	type ConformanceRunView,
} from "./conformance.types.ts";
import { createSafeDiscoveryTarget, SAFE_DISCOVERY_PLAN } from "./safe-discovery.plan.ts";

const MAX_CONFORMANCE_RUN_TIMEOUT_MS = 8_000;
const MANAGER_TIMEOUT_HEADROOM_MS = 50;

@Injectable()
export class ConformanceService implements OnApplicationShutdown {
	readonly #controllers = new Map<string, AbortController>();
	readonly #tasks = new Map<string, Promise<void>>();

	constructor(
		@Inject(ConformanceRunRepository)
		private readonly runs: ConformanceRunRepository,
		@Inject(ConnectionRepository)
		private readonly connections: ConnectionRepository,
		@Inject(MCP_RUNTIME_SUPERVISOR)
		private readonly runtime: McpRuntimeManagerPort,
		@Inject(VolatileOAuthAuthorityService)
		private readonly oauth: VolatileOAuthAuthorityService,
		@Inject(ControlPlaneConfigService)
		private readonly config: ControlPlaneConfigService,
	) {}

	start(input: CreateConformanceRunDto): ConformanceRunView {
		const record = this.#assertTarget(input.target);
		const target = Object.freeze({ ...input.target }) satisfies ConformanceRunTarget;
		const run = this.runs.create(target);
		const controller = new AbortController();
		this.#controllers.set(run.runId, controller);
		const task = Promise.resolve().then(() =>
			this.#execute(run.runId, record.generationKey, controller),
		);
		this.#tasks.set(run.runId, task);
		void task.then(
			() => this.#tasks.delete(run.runId),
			() => this.#tasks.delete(run.runId),
		);
		return run;
	}

	async onApplicationShutdown(): Promise<void> {
		for (const controller of this.#controllers.values()) controller.abort("APP_SHUTDOWN");
		await Promise.allSettled(this.#tasks.values());
	}

	list(connectionId: string, runtimeGeneration: number, limit: number): ConformanceRunListView {
		return this.runs.list(connectionId, runtimeGeneration, limit);
	}

	get(runId: string): ConformanceRunView {
		return this.runs.get(runId);
	}

	cancel(runId: string): ConformanceRunView {
		const run = this.runs.requestCancellation(runId);
		this.#controllers.get(runId)?.abort("RUN_CANCELLED");
		return run;
	}

	#assertTarget(target: ConformanceRunTarget): ConnectionRecord {
		const record = this.connections.get(target.connectionId);
		if (record.revision !== target.expectedRevision) {
			throw new ControlPlaneError(
				"MCP_REVISION_CONFLICT",
				409,
				"The MCP connection changed after it was read.",
			);
		}
		if (record.runtimeGeneration !== target.runtimeGeneration) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The requested MCP runtime generation has been retired.",
			);
		}
		if (record.deletionPending) {
			throw new ControlPlaneError(
				"MCP_CONNECTION_DELETING",
				409,
				"The MCP connection is fenced for deletion.",
			);
		}
		if (record.authenticationKind === "oauth" && !this.oauth.isAuthorized(record.generationKey)) {
			throw new ControlPlaneError(
				"MCP_OAUTH_AUTHORIZATION_REQUIRED",
				409,
				"The MCP connection requires OAuth authorization.",
			);
		}
		if (
			record.desiredState !== "online" ||
			this.runtime.state(record.generationKey).phase !== "online"
		) {
			throw new ControlPlaneError(
				"MCP_NOT_READY",
				409,
				"The MCP connection must be online before conformance can run.",
			);
		}
		return record;
	}

	async #execute(runId: string, generationKey: string, controller: AbortController): Promise<void> {
		try {
			if (controller.signal.aborted) {
				this.runs.cancelBeforeStart(runId);
				return;
			}
			const running = this.runs.markRunning(runId);
			const runTimeoutMs = Math.min(
				MAX_CONFORMANCE_RUN_TIMEOUT_MS,
				Math.max(1, this.config.requestTimeoutMs - MANAGER_TIMEOUT_HEADROOM_MS),
			);
			const leasedRun = await this.runtime.withClientRuntime(
				generationKey,
				async ({ runtime, serverName, signal }) => {
					const report = await runMcpConformancePlan(SAFE_DISCOVERY_PLAN, {
						target: createSafeDiscoveryTarget({
							runtime,
							serverName,
							leaseSignal: signal,
							maxPages: this.config.maxDiscoveryPages,
							maxItems: this.config.maxDiscoveryItems,
						}),
						runId,
						descriptor: {
							target: {
								kind: "connection",
								id: running.target.connectionId,
								revision: running.target.expectedRevision,
								generation: running.target.runtimeGeneration,
							},
							subject: MCP_CONFORMANCE_SUBJECT,
						},
						signal: controller.signal,
						allowSideEffects: false,
						limits: { runTimeoutMs, checkTimeoutMs: Math.min(2_000, runTimeoutMs) },
					});
					return Object.freeze({
						report,
						leaseAbort: classifyLeaseAbort(signal, controller.signal),
					});
				},
				controller.signal,
			);

			if (leasedRun.leaseAbort === "generation-retired") {
				this.runs.fail(runId, "MCP_CONFORMANCE_TARGET_CHANGED");
				return;
			}
			if (leasedRun.leaseAbort !== undefined) {
				this.runs.fail(runId, "MCP_CONFORMANCE_RUN_FAILED");
				return;
			}
			if (!this.#targetStillCurrent(running.target)) {
				this.runs.fail(runId, "MCP_CONFORMANCE_TARGET_CHANGED");
				return;
			}
			this.runs.complete(runId, leasedRun.report);
		} catch (error) {
			if (controller.signal.aborted) this.runs.cancelBeforeStart(runId);
			else if (hasErrorCode(error, MCP_RUNTIME_GENERATION_RETIRED)) {
				this.runs.fail(runId, "MCP_CONFORMANCE_TARGET_CHANGED");
			} else this.runs.fail(runId, "MCP_CONFORMANCE_RUN_FAILED");
		} finally {
			this.#controllers.delete(runId);
		}
	}

	#targetStillCurrent(target: ConformanceRunTarget): boolean {
		try {
			const current = this.connections.get(target.connectionId);
			return (
				current.revision === target.expectedRevision &&
				current.runtimeGeneration === target.runtimeGeneration &&
				!current.deletionPending &&
				current.desiredState === "online" &&
				this.runtime.state(current.generationKey).phase === "online" &&
				(current.authenticationKind !== "oauth" || this.oauth.isAuthorized(current.generationKey))
			);
		} catch {
			return false;
		}
	}
}

type LeaseAbort = "generation-retired" | "manager-timeout" | "runtime-aborted";

function classifyLeaseAbort(
	leaseSignal: AbortSignal,
	callerSignal: AbortSignal,
): LeaseAbort | undefined {
	if (!leaseSignal.aborted || callerSignal.aborted) return undefined;
	const reason = leaseSignal.reason as unknown;
	if (hasErrorCode(reason, MCP_CLIENT_LEASE_INVALIDATED)) return "generation-retired";
	if (reason instanceof DOMException && reason.name === "TimeoutError") return "manager-timeout";
	return "runtime-aborted";
}

function hasErrorCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
