import {
	defineMcpConformancePlan,
	runMcpConformancePlan,
	serializeMcpConformanceReport,
	type McpConformanceCheckOutcome,
} from "../src/index.ts";
import { describe, expect, it, vi } from "vitest";

const descriptor = {
	target: { kind: "connection", id: "fixture-a", revision: 3, generation: 2 },
	subject: { name: "@nest-mcp/nestjs", version: "2.0.0-alpha.0" },
} as const;

describe("runMcpConformancePlan", () => {
	it("rejects clocks that cannot produce exact report timestamps", async () => {
		const plan = defineMcpConformancePlan({
			id: "clock",
			version: "1",
			title: "Clock",
			checks: [
				{
					id: "clock.check",
					title: "Clock check",
					risk: "read-only",
					run: () => ({ status: "pass", code: "CLOCK_OK" }),
				},
			],
		});
		await expect(
			runMcpConformancePlan(plan, {
				target: {},
				runId: "fractional-clock",
				descriptor,
				now: () => 1_000.5,
			}),
		).rejects.toThrow(/safe-integer epoch millisecond/u);
	});

	it("executes checks sequentially and preserves plan order", async () => {
		const order: string[] = [];
		const plan = defineMcpConformancePlan({
			id: "ordered",
			version: "1",
			title: "Ordered checks",
			checks: [
				{
					id: "first",
					title: "First",
					risk: "read-only",
					async run() {
						order.push("first:start");
						await Promise.resolve();
						order.push("first:end");
						return { status: "pass", code: "FIRST_OK" };
					},
				},
				{
					id: "second",
					title: "Second",
					risk: "read-only",
					run() {
						order.push("second");
						return { status: "warn", code: "SECOND_REVIEW" } as const;
					},
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "ordered-run",
			descriptor,
		});

		expect(order).toEqual(["first:start", "first:end", "second"]);
		expect(report.checks.map((check) => check.id)).toEqual(["first", "second"]);
		expect(report.counts).toEqual({ pass: 1, warn: 1, fail: 0, skip: 0, error: 0 });
		expect(report.verdict).toBe("warn");
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.checks)).toBe(true);
	});

	it("gates side effects unless the caller explicitly enables them", async () => {
		const execute = vi.fn(() => ({ status: "pass", code: "CALLED" }) as const);
		const plan = defineMcpConformancePlan({
			id: "active",
			version: "1",
			title: "Active checks",
			checks: [{ id: "fixture.call", title: "Fixture call", risk: "side-effecting", run: execute }],
		});
		const gated = await runMcpConformancePlan(plan, {
			target: {},
			runId: "gated",
			descriptor,
		});
		expect(gated.checks[0]).toMatchObject({ status: "skip", code: "SIDE_EFFECTS_DISABLED" });
		expect(execute).not.toHaveBeenCalled();

		const enabled = await runMcpConformancePlan(plan, {
			target: {},
			runId: "enabled",
			descriptor,
			allowSideEffects: true,
		});
		expect(enabled.checks[0]).toMatchObject({ status: "pass", code: "CALLED" });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("never serializes thrown error details and projects only bounded safe facts", async () => {
		const secret = "super-secret-value";
		const outcomes: McpConformanceCheckOutcome[] = [
			{
				status: "pass",
				code: "FACTS_OK",
				facts: {
					count: 2,
					toolCount: 4,
					access_token: secret,
					detail: "x".repeat(80),
				},
			},
		];
		const plan = defineMcpConformancePlan({
			id: "redaction",
			version: "1",
			title: "Redaction",
			checks: [
				{ id: "facts", title: "Facts", risk: "read-only", run: () => outcomes[0]! },
				{
					id: "throws",
					title: "Throws",
					risk: "read-only",
					run: () => {
						throw new Error(`Authorization: Bearer ${secret}`);
					},
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "redacted",
			descriptor,
			limits: { maxFactStringLength: 16 },
		});

		expect(report.checks[0]?.facts).toEqual({
			count: 2,
			detail: "x".repeat(16),
			toolCount: 4,
		});
		expect(report.checks[0]?.factsOmittedCount).toBe(2);
		expect(report.checks[1]).toMatchObject({ status: "error", code: "CHECK_THREW" });
		expect(serializeMcpConformanceReport(report)).not.toContain(secret);
		expect(serializeMcpConformanceReport(report)).not.toContain("Authorization");
	});

	it("propagates caller cancellation and materializes the remaining report shape", async () => {
		const controller = new AbortController();
		const second = vi.fn(() => ({ status: "pass", code: "SECOND_OK" }) as const);
		const plan = defineMcpConformancePlan({
			id: "cancel",
			version: "1",
			title: "Cancellation",
			checks: [
				{
					id: "waiting",
					title: "Waiting",
					risk: "read-only",
					run: ({ signal }) =>
						new Promise<McpConformanceCheckOutcome>((resolve) => {
							signal.addEventListener(
								"abort",
								() => resolve({ status: "skip", code: "TARGET_ABORTED" }),
								{ once: true },
							);
						}),
				},
				{ id: "second", title: "Second", risk: "read-only", run: second },
			],
		});
		const running = runMcpConformancePlan(plan, {
			target: {},
			runId: "cancelled",
			descriptor,
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();
		const report = await running;

		expect(report.completion).toBe("cancelled");
		expect(report.verdict).toBe("inconclusive");
		expect(report.checks.map((check) => check.code)).toEqual(["RUN_CANCELLED", "RUN_CANCELLED"]);
		expect(second).not.toHaveBeenCalled();
	});

	it("bounds non-cooperative checks and does not launch later checks concurrently", async () => {
		const later = vi.fn(() => ({ status: "pass", code: "LATER_OK" }) as const);
		const plan = defineMcpConformancePlan({
			id: "timeout",
			version: "1",
			title: "Timeout",
			checks: [
				{
					id: "stuck",
					title: "Stuck",
					risk: "read-only",
					timeoutMs: 10,
					run: () => new Promise<McpConformanceCheckOutcome>(() => undefined),
				},
				{ id: "later", title: "Later", risk: "read-only", run: later },
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "timed-check",
			descriptor,
		});

		expect(report.completion).toBe("completed");
		expect(report.verdict).toBe("inconclusive");
		expect(report.checks).toMatchObject([
			{ status: "error", code: "CHECK_TIMED_OUT" },
			{ status: "skip", code: "PREVIOUS_CHECK_TIMED_OUT" },
		]);
		expect(later).not.toHaveBeenCalled();
	});

	it("distinguishes a whole-run timeout from caller cancellation", async () => {
		const plan = defineMcpConformancePlan({
			id: "run-timeout",
			version: "1",
			title: "Run timeout",
			checks: [
				{
					id: "stuck",
					title: "Stuck",
					risk: "read-only",
					timeoutMs: 1_000,
					run: () => new Promise<McpConformanceCheckOutcome>(() => undefined),
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "whole-run-timeout",
			descriptor,
			limits: { runTimeoutMs: 10 },
		});
		expect(report).toMatchObject({
			completion: "timed-out",
			verdict: "inconclusive",
			checks: [{ status: "error", code: "RUN_TIMED_OUT" }],
		});
	});

	it("accepts stable infrastructure errors without exception details", async () => {
		const plan = defineMcpConformancePlan({
			id: "infrastructure",
			version: "1",
			title: "Infrastructure",
			checks: [
				{
					id: "catalog",
					title: "Catalog",
					risk: "read-only",
					run: () => ({ status: "error", code: "TARGET_UNAVAILABLE" }),
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "stable-error",
			descriptor,
		});
		expect(report).toMatchObject({
			completion: "completed",
			verdict: "inconclusive",
			checks: [{ status: "error", code: "TARGET_UNAVAILABLE" }],
		});
	});

	it("contains observer failures", async () => {
		const observerError = vi.fn();
		const plan = defineMcpConformancePlan({
			id: "observer",
			version: "1",
			title: "Observer",
			checks: [
				{
					id: "one",
					title: "One",
					risk: "read-only",
					run: () => ({ status: "pass", code: "ONE_OK" }),
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "observer-errors",
			descriptor,
			observer: () => {
				throw new Error("observer failed");
			},
			onObserverError: observerError,
		});
		expect(report.verdict).toBe("pass");
		expect(observerError).toHaveBeenCalledTimes(4);
	});

	it("does not let a pending observer delay or defeat run bounds", async () => {
		const observer = vi.fn(() => new Promise<void>(() => undefined));
		const plan = defineMcpConformancePlan({
			id: "pending-observer",
			version: "1",
			title: "Pending observer",
			checks: [
				{
					id: "one",
					title: "One",
					risk: "read-only",
					run: () => ({ status: "pass", code: "ONE_OK" }),
				},
			],
		});
		const report = await runMcpConformancePlan(plan, {
			target: {},
			runId: "pending-observer",
			descriptor,
			limits: { runTimeoutMs: 10 },
			observer,
		});

		expect(report).toMatchObject({ completion: "completed", verdict: "pass" });
		expect(observer).toHaveBeenCalledTimes(4);
	});
});
