import { projectMcpConformanceFacts } from "./facts.ts";
import { resolveMcpConformanceLimits, type ResolvedMcpConformanceLimits } from "./limits.ts";
import { defineMcpConformancePlan, digestMcpConformancePlan } from "./plan.ts";
import {
	countMcpConformanceStatuses,
	deriveMcpConformanceVerdict,
	parseMcpConformanceDescriptor,
	parseMcpConformanceReport,
	type McpConformanceCheckReport,
	type McpConformanceReport,
} from "./report.ts";
import type {
	McpConformanceCheck,
	McpConformanceCheckOutcome,
	McpConformanceCheckStatus,
	McpConformanceObserverEvent,
	McpConformancePlan,
	McpConformanceRunnerOptions,
	McpConformanceRunCompletion,
} from "./types.ts";

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const OUTCOME_STATUSES: ReadonlySet<string> = new Set(["pass", "warn", "fail", "skip", "error"]);
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export async function runMcpConformancePlan<Target>(
	inputPlan: McpConformancePlan<Target>,
	options: McpConformanceRunnerOptions<Target>,
): Promise<McpConformanceReport> {
	const plan = defineMcpConformancePlan(inputPlan);
	const limits = resolveMcpConformanceLimits(options.limits);
	if (plan.checks.length > limits.maxChecks) {
		throw new RangeError(
			`The plan exceeds the configured ${String(limits.maxChecks)} check limit.`,
		);
	}
	assertRunId(options.runId);
	const descriptor = parseMcpConformanceDescriptor(options.descriptor);
	const now = safeClock(options.now ?? Date.now);
	const startedMs = now();
	const startedAt = new Date(startedMs).toISOString();
	const runTimeoutController = new AbortController();
	const runTimeout = setTimeout(
		() => runTimeoutController.abort("RUN_TIMED_OUT"),
		limits.runTimeoutMs,
	);
	const runSignal = AbortSignal.any([
		runTimeoutController.signal,
		...(options.signal === undefined ? [] : [options.signal]),
	]);
	const reports: McpConformanceCheckReport[] = [];
	let completion: McpConformanceRunCompletion = "completed";
	let haltCode: string | undefined;

	emit(options, {
		type: "run.started",
		runId: options.runId,
		timestamp: startedAt,
		checkCount: plan.checks.length,
	});

	try {
		for (const check of plan.checks) {
			const cancellation = classifyRunAbort(options.signal, runTimeoutController.signal);
			if (cancellation !== undefined) {
				completion = cancellation.completion;
				reports.push(await skippedReport(check, cancellation.code, options, now));
				continue;
			}
			if (haltCode !== undefined) {
				reports.push(await skippedReport(check, haltCode, options, now));
				continue;
			}
			if (check.risk === "side-effecting" && options.allowSideEffects !== true) {
				reports.push(await skippedReport(check, "SIDE_EFFECTS_DISABLED", options, now));
				continue;
			}

			const executed = await executeCheck(
				check,
				options,
				limits,
				runSignal,
				runTimeoutController.signal,
				now,
			);
			reports.push(executed.report);
			if (executed.abort === "cancelled") completion = "cancelled";
			if (executed.abort === "timed-out") completion = "timed-out";
			if (executed.abort === "check-timed-out") haltCode = "PREVIOUS_CHECK_TIMED_OUT";
		}
	} finally {
		clearTimeout(runTimeout);
	}

	const finalAbort = classifyRunAbort(options.signal, runTimeoutController.signal);
	if (finalAbort !== undefined) completion = finalAbort.completion;
	const counts = countMcpConformanceStatuses(reports);
	const verdict = deriveMcpConformanceVerdict(completion, counts);
	const finishedMs = Math.max(startedMs, now());
	const finishedAt = new Date(finishedMs).toISOString();
	const report = parseMcpConformanceReport(
		{
			reportSchemaVersion: 1,
			fingerprintVersion: 1,
			runId: options.runId,
			plan: {
				id: plan.id,
				version: plan.version,
				title: plan.title,
				digest: digestMcpConformancePlan(plan),
				checks: plan.checks.map((check) => ({
					id: check.id,
					title: check.title,
					risk: check.risk,
				})),
			},
			descriptor,
			startedAt,
			finishedAt,
			durationMs: Math.floor(finishedMs - startedMs),
			completion,
			verdict,
			counts,
			checks: reports,
		},
		{ maximumBytes: limits.maxJsonBytes },
	);
	emit(options, {
		type: "run.completed",
		runId: options.runId,
		timestamp: finishedAt,
		completion,
		verdict,
	});
	return report;
}

type CheckAbort = "cancelled" | "timed-out" | "check-timed-out";

async function executeCheck<Target>(
	check: McpConformanceCheck<Target>,
	options: McpConformanceRunnerOptions<Target>,
	limits: ResolvedMcpConformanceLimits,
	runSignal: AbortSignal,
	runTimeoutSignal: AbortSignal,
	now: () => number,
): Promise<{ readonly report: McpConformanceCheckReport; readonly abort?: CheckAbort }> {
	const startedMs = now();
	emit(options, {
		type: "check.started",
		runId: options.runId,
		timestamp: new Date(startedMs).toISOString(),
		checkId: check.id,
	});
	const timeoutController = new AbortController();
	const timeout = setTimeout(
		() => timeoutController.abort("CHECK_TIMED_OUT"),
		check.timeoutMs ?? limits.checkTimeoutMs,
	);
	const signal = AbortSignal.any([runSignal, timeoutController.signal]);
	let settled: SettledCheck;
	try {
		if (signal.aborted) settled = { kind: "aborted" };
		else settled = await raceCheck(check, options.target, signal);
	} finally {
		clearTimeout(timeout);
	}

	let status: McpConformanceCheckStatus;
	let code: string;
	let facts: McpConformanceCheckOutcome["facts"];
	let abort: CheckAbort | undefined;
	if (settled.kind === "value" && isOutcome(settled.value)) {
		status = settled.value.status;
		code = settled.value.code;
		facts = settled.value.facts;
	} else if (settled.kind === "value") {
		status = "error";
		code = "CHECK_RESULT_INVALID";
	} else if (settled.kind === "threw") {
		status = "error";
		code = "CHECK_THREW";
	} else if (options.signal?.aborted === true) {
		status = "skip";
		code = "RUN_CANCELLED";
		abort = "cancelled";
	} else if (runTimeoutSignal.aborted) {
		status = "error";
		code = "RUN_TIMED_OUT";
		abort = "timed-out";
	} else {
		status = "error";
		code = "CHECK_TIMED_OUT";
		abort = "check-timed-out";
	}
	const projection = projectMcpConformanceFacts(facts, {
		maximum: limits.maxFactsPerCheck,
		maximumStringLength: limits.maxFactStringLength,
	});
	const finishedMs = Math.max(startedMs, now());
	const report = Object.freeze({
		id: check.id,
		title: check.title,
		risk: check.risk,
		status,
		code,
		durationMs: Math.floor(finishedMs - startedMs),
		facts: projection.facts,
		factsOmittedCount: projection.omittedCount,
	}) as McpConformanceCheckReport;
	emit(options, {
		type: "check.completed",
		runId: options.runId,
		timestamp: new Date(finishedMs).toISOString(),
		checkId: check.id,
		status,
		code,
	});
	return abort === undefined ? { report } : { report, abort };
}

async function skippedReport<Target>(
	check: McpConformanceCheck<Target>,
	code: string,
	options: McpConformanceRunnerOptions<Target>,
	now: () => number,
): Promise<McpConformanceCheckReport> {
	const timestamp = new Date(now()).toISOString();
	const report = Object.freeze({
		id: check.id,
		title: check.title,
		risk: check.risk,
		status: "skip" as const,
		code,
		durationMs: 0,
		facts: Object.freeze({}),
		factsOmittedCount: 0,
	}) as McpConformanceCheckReport;
	emit(options, {
		type: "check.completed",
		runId: options.runId,
		timestamp,
		checkId: check.id,
		status: "skip",
		code,
	});
	return report;
}

type SettledCheck =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "threw" }
	| { readonly kind: "aborted" };

function raceCheck<Target>(
	check: McpConformanceCheck<Target>,
	target: Target,
	signal: AbortSignal,
): Promise<SettledCheck> {
	const task: Promise<SettledCheck> = Promise.resolve()
		.then(() => check.run(Object.freeze({ target, signal })))
		.then(
			(value) => ({ kind: "value" as const, value }),
			() => ({ kind: "threw" as const }),
		);
	return new Promise<SettledCheck>((resolve) => {
		let finished = false;
		const finish = (result: SettledCheck): void => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = (): void => finish({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		void task.then(finish);
	});
}

function isOutcome(value: unknown): value is McpConformanceCheckOutcome {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<McpConformanceCheckOutcome>;
	if (
		typeof candidate.status !== "string" ||
		!OUTCOME_STATUSES.has(candidate.status) ||
		typeof candidate.code !== "string" ||
		!CODE.test(candidate.code)
	) {
		return false;
	}
	return (
		candidate.facts === undefined ||
		(typeof candidate.facts === "object" &&
			candidate.facts !== null &&
			!Array.isArray(candidate.facts))
	);
}

function classifyRunAbort(
	callerSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): { readonly completion: McpConformanceRunCompletion; readonly code: string } | undefined {
	if (callerSignal?.aborted === true) return { completion: "cancelled", code: "RUN_CANCELLED" };
	if (timeoutSignal.aborted) return { completion: "timed-out", code: "RUN_TIMED_OUT" };
	return undefined;
}

function emit<Target>(
	options: McpConformanceRunnerOptions<Target>,
	event: McpConformanceObserverEvent,
): void {
	if (options.observer === undefined) return;
	const frozenEvent = Object.freeze(event);
	try {
		const observed = options.observer(frozenEvent);
		void Promise.resolve(observed).catch((error: unknown) => {
			reportObserverError(options, error, frozenEvent);
		});
	} catch (error) {
		reportObserverError(options, error, frozenEvent);
	}
}

function reportObserverError<Target>(
	options: McpConformanceRunnerOptions<Target>,
	error: unknown,
	event: McpConformanceObserverEvent,
): void {
	try {
		const reported = options.onObserverError?.(error, event);
		void Promise.resolve(reported).catch(() => {
			// Observer diagnostics are deliberately best-effort.
		});
	} catch {
		// Observer diagnostics are deliberately best-effort.
	}
}

function safeClock(clock: () => number): () => number {
	return () => {
		const value = clock();
		if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_EPOCH_MS) {
			throw new TypeError(
				"The conformance clock must return a non-negative safe-integer epoch millisecond timestamp.",
			);
		}
		return value;
	};
}

function assertRunId(runId: string): void {
	if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) {
		throw new TypeError("runId must be a non-empty string no longer than 128 characters.");
	}
}
