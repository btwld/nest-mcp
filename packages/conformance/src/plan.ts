import { fingerprintMcpConformanceValue } from "./fingerprint.ts";
import { MCP_CONFORMANCE_HARD_LIMITS } from "./limits.ts";
import type {
	McpConformanceCheck,
	McpConformanceCheckContext,
	McpConformancePlan,
} from "./types.ts";

const IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export function defineMcpConformancePlan<Target>(
	input: McpConformancePlan<Target>,
): McpConformancePlan<Target> {
	assertIdentifier(input?.id, "plan.id");
	assertBoundedString(input.version, "plan.version", 64);
	assertBoundedString(input.title, "plan.title", 120);
	if (!Array.isArray(input.checks) || input.checks.length === 0) {
		throw new TypeError("plan.checks must contain at least one check.");
	}
	if (input.checks.length > MCP_CONFORMANCE_HARD_LIMITS.maxChecks) {
		throw new RangeError(
			`plan.checks must not contain more than ${String(MCP_CONFORMANCE_HARD_LIMITS.maxChecks)} checks.`,
		);
	}
	const ids = new Set<string>();
	const checks = input.checks.map((check, index) => snapshotCheck(check, index, ids));
	return Object.freeze({
		id: input.id,
		version: input.version,
		title: input.title,
		checks: Object.freeze(checks),
	});
}

export function digestMcpConformancePlan<Target>(plan: McpConformancePlan<Target>): string {
	return fingerprintMcpConformanceValue(
		{
			id: plan.id,
			version: plan.version,
			title: plan.title,
			checks: plan.checks.map((check) => ({
				id: check.id,
				title: check.title,
				risk: check.risk,
				...(check.description === undefined ? {} : { description: check.description }),
				...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
			})),
		},
		"plan",
	);
}

function snapshotCheck<Target>(
	check: McpConformanceCheck<Target>,
	index: number,
	ids: Set<string>,
): McpConformanceCheck<Target> {
	assertIdentifier(check?.id, `plan.checks[${String(index)}].id`);
	if (ids.has(check.id)) throw new TypeError(`Duplicate conformance check id: ${check.id}.`);
	ids.add(check.id);
	assertBoundedString(check.title, `plan.checks[${String(index)}].title`, 120);
	if (check.description !== undefined) {
		assertBoundedString(check.description, `plan.checks[${String(index)}].description`, 512);
	}
	if (check.risk !== "read-only" && check.risk !== "side-effecting") {
		throw new TypeError(`plan.checks[${String(index)}].risk is invalid.`);
	}
	if (check.timeoutMs !== undefined) {
		if (
			!Number.isSafeInteger(check.timeoutMs) ||
			check.timeoutMs <= 0 ||
			check.timeoutMs > MCP_CONFORMANCE_HARD_LIMITS.maxCheckTimeoutMs
		) {
			throw new RangeError(
				`plan.checks[${String(index)}].timeoutMs must be a positive integer no greater than ${String(MCP_CONFORMANCE_HARD_LIMITS.maxCheckTimeoutMs)}.`,
			);
		}
	}
	if (typeof check.run !== "function") {
		throw new TypeError(`plan.checks[${String(index)}].run must be a function.`);
	}
	const run = check.run;
	return Object.freeze({
		id: check.id,
		title: check.title,
		...(check.description === undefined ? {} : { description: check.description }),
		risk: check.risk,
		...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
		run: (context: McpConformanceCheckContext<Target>) => run(context),
	});
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length > 64 || !IDENTIFIER.test(value)) {
		throw new TypeError(`${name} must be a bounded lowercase identifier.`);
	}
}

function assertBoundedString(
	value: unknown,
	name: string,
	maximum: number,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new TypeError(`${name} must be a non-empty string no longer than ${String(maximum)}.`);
	}
}
