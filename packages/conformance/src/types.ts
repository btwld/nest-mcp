import type { McpConformanceLimits } from "./limits.ts";
import type { McpConformanceDescriptor, McpConformanceReport } from "./report.ts";

export type McpConformanceCheckStatus = "pass" | "warn" | "fail" | "skip" | "error";
export type McpConformanceCheckOutcomeStatus = McpConformanceCheckStatus;
export type McpConformanceCheckRisk = "read-only" | "side-effecting";
export type McpConformanceRunCompletion = "completed" | "cancelled" | "timed-out";
export type McpConformanceVerdict = "pass" | "warn" | "fail" | "inconclusive";
export type McpConformanceFactValue = string | number | boolean | null;

export interface McpConformanceCheckOutcome {
	readonly status: McpConformanceCheckOutcomeStatus;
	readonly code: string;
	readonly facts?: Readonly<Record<string, McpConformanceFactValue>>;
}

export interface McpConformanceCheckContext<Target> {
	readonly target: Target;
	readonly signal: AbortSignal;
}

export interface McpConformanceCheck<Target> {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly risk: McpConformanceCheckRisk;
	readonly timeoutMs?: number;
	readonly run: (
		context: McpConformanceCheckContext<Target>,
	) => McpConformanceCheckOutcome | Promise<McpConformanceCheckOutcome>;
}

export interface McpConformancePlan<Target> {
	readonly id: string;
	readonly version: string;
	readonly title: string;
	readonly checks: readonly McpConformanceCheck<Target>[];
}

export type McpConformanceObserverEvent =
	| {
			readonly type: "run.started";
			readonly runId: string;
			readonly timestamp: string;
			readonly checkCount: number;
	  }
	| {
			readonly type: "check.started";
			readonly runId: string;
			readonly timestamp: string;
			readonly checkId: string;
	  }
	| {
			readonly type: "check.completed";
			readonly runId: string;
			readonly timestamp: string;
			readonly checkId: string;
			readonly status: McpConformanceCheckStatus;
			readonly code: string;
	  }
	| {
			readonly type: "run.completed";
			readonly runId: string;
			readonly timestamp: string;
			readonly completion: McpConformanceRunCompletion;
			readonly verdict: McpConformanceVerdict;
	  };

export interface McpConformanceRunnerOptions<Target> {
	readonly target: Target;
	readonly runId: string;
	readonly descriptor: McpConformanceDescriptor;
	readonly signal?: AbortSignal;
	readonly allowSideEffects?: boolean;
	readonly limits?: McpConformanceLimits;
	readonly observer?: (event: McpConformanceObserverEvent) => void | Promise<void>;
	readonly onObserverError?: (
		error: unknown,
		event: McpConformanceObserverEvent,
	) => void | Promise<void>;
	readonly now?: () => number;
}

export type McpConformanceRunResult = McpConformanceReport;
