import type { McpConformanceReport } from "@nest-mcp/conformance";

export const SAFE_DISCOVERY_PLAN_ID = "safe-discovery-v1" as const;

export type ConformanceRunStatus =
	"queued" | "running" | "cancelling" | "completed" | "cancelled" | "timed-out" | "failed";

export interface ConformanceRunTarget {
	readonly kind: "connection";
	readonly connectionId: string;
	readonly expectedRevision: number;
	readonly runtimeGeneration: number;
}

export interface ConformanceRunView {
	readonly runId: string;
	readonly planId: typeof SAFE_DISCOVERY_PLAN_ID;
	readonly target: ConformanceRunTarget;
	readonly status: ConformanceRunStatus;
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly errorCode?: string;
	readonly report?: McpConformanceReport;
}

export interface ConformanceRunListView {
	readonly runs: readonly ConformanceRunView[];
}

export function isTerminalConformanceRun(status: ConformanceRunStatus): boolean {
	return (
		status === "completed" ||
		status === "cancelled" ||
		status === "timed-out" ||
		status === "failed"
	);
}
