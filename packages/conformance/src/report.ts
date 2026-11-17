import { z } from "zod";

import { MCP_CONFORMANCE_DEFAULT_LIMITS, MCP_CONFORMANCE_HARD_LIMITS } from "./limits.ts";

const identifierSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const codeSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/u);
const fingerprintSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u);
const boundedLabelSchema = z.string().min(1).max(256);
const dateTimeSchema = z.string().datetime({ offset: true });
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const factValueSchema = z.union([
	z.string().max(MCP_CONFORMANCE_HARD_LIMITS.maxFactStringLength),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
const factsSchema = z
	.record(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/u),
		factValueSchema,
	)
	.refine((facts) => Object.keys(facts).length <= MCP_CONFORMANCE_HARD_LIMITS.maxFactsPerCheck, {
		message: "A check report contains too many facts.",
	});

const checkStatusSchema = z.enum(["pass", "warn", "fail", "skip", "error"]);
const checkRiskSchema = z.enum(["read-only", "side-effecting"]);
const completionSchema = z.enum(["completed", "cancelled", "timed-out"]);
const verdictSchema = z.enum(["pass", "warn", "fail", "inconclusive"]);

export const McpConformanceDescriptorSchema = z
	.object({
		target: z
			.object({
				kind: identifierSchema,
				id: boundedLabelSchema,
				revision: positiveSafeIntegerSchema.optional(),
				generation: positiveSafeIntegerSchema.optional(),
			})
			.strict(),
		/** The observing client build that produced this report — never the observed target. */
		subject: z
			.object({
				name: boundedLabelSchema,
				version: boundedLabelSchema,
				revision: boundedLabelSchema.optional(),
			})
			.strict(),
		fixtureVersion: boundedLabelSchema.optional(),
	})
	.strict();

const planCheckSchema = z
	.object({
		id: identifierSchema,
		title: z.string().min(1).max(120),
		risk: checkRiskSchema,
	})
	.strict();

const planSnapshotSchema = z
	.object({
		id: identifierSchema,
		version: z.string().min(1).max(64),
		title: z.string().min(1).max(120),
		digest: fingerprintSchema,
		checks: z.array(planCheckSchema).min(1).max(MCP_CONFORMANCE_HARD_LIMITS.maxChecks),
	})
	.strict();

const checkReportSchema = z
	.object({
		id: identifierSchema,
		title: z.string().min(1).max(120),
		risk: checkRiskSchema,
		status: checkStatusSchema,
		code: codeSchema,
		durationMs: nonnegativeSafeIntegerSchema,
		facts: factsSchema,
		factsOmittedCount: nonnegativeSafeIntegerSchema,
	})
	.strict();

const countsSchema = z
	.object({
		pass: nonnegativeSafeIntegerSchema,
		warn: nonnegativeSafeIntegerSchema,
		fail: nonnegativeSafeIntegerSchema,
		skip: nonnegativeSafeIntegerSchema,
		error: nonnegativeSafeIntegerSchema,
	})
	.strict();

export const McpConformanceReportSchema = z
	.object({
		reportSchemaVersion: z.literal(1),
		fingerprintVersion: z.literal(1),
		runId: z.string().min(1).max(128),
		plan: planSnapshotSchema,
		descriptor: McpConformanceDescriptorSchema,
		startedAt: dateTimeSchema,
		finishedAt: dateTimeSchema,
		durationMs: nonnegativeSafeIntegerSchema,
		completion: completionSchema,
		verdict: verdictSchema,
		counts: countsSchema,
		checks: z.array(checkReportSchema).min(1).max(MCP_CONFORMANCE_HARD_LIMITS.maxChecks),
	})
	.strict()
	.superRefine((report, context) => {
		const planIds = new Set<string>();
		for (const [index, check] of report.plan.checks.entries()) {
			if (planIds.has(check.id)) {
				context.addIssue({
					code: "custom",
					message: "Plan check identities must be unique.",
					path: ["plan", "checks", index, "id"],
				});
			}
			planIds.add(check.id);
		}
		const reportIds = new Set<string>();
		for (const [index, check] of report.checks.entries()) {
			if (reportIds.has(check.id)) {
				context.addIssue({
					code: "custom",
					message: "Report check identities must be unique.",
					path: ["checks", index, "id"],
				});
			}
			reportIds.add(check.id);
		}
		if (report.plan.checks.length !== report.checks.length) {
			context.addIssue({ code: "custom", message: "Plan and report check counts differ." });
			return;
		}
		for (const [index, check] of report.checks.entries()) {
			const planned = report.plan.checks[index];
			if (
				planned === undefined ||
				planned.id !== check.id ||
				planned.title !== check.title ||
				planned.risk !== check.risk
			) {
				context.addIssue({
					code: "custom",
					message: "Plan and report check order differ.",
					path: ["checks", index],
				});
			}
		}
		const observed = countStatuses(report.checks);
		for (const status of checkStatusSchema.options) {
			if (observed[status] !== report.counts[status]) {
				context.addIssue({
					code: "custom",
					message: "Reported status counts are inconsistent.",
					path: ["counts", status],
				});
			}
		}
		if (deriveVerdict(report.completion, observed) !== report.verdict) {
			context.addIssue({
				code: "custom",
				message: "The report verdict is inconsistent with its checks.",
				path: ["verdict"],
			});
		}
		const startedMs = Date.parse(report.startedAt);
		const finishedMs = Date.parse(report.finishedAt);
		if (finishedMs < startedMs) {
			context.addIssue({
				code: "custom",
				message: "The report cannot finish before it starts.",
				path: ["finishedAt"],
			});
		} else if (Math.floor(finishedMs - startedMs) !== report.durationMs) {
			context.addIssue({
				code: "custom",
				message: "The report duration must match its timestamps.",
				path: ["durationMs"],
			});
		}
		if (
			new TextEncoder().encode(JSON.stringify(report)).byteLength >
			MCP_CONFORMANCE_HARD_LIMITS.maxJsonBytes
		) {
			context.addIssue({
				code: "custom",
				message: "The report exceeds the hard JSON byte safety limit.",
			});
		}
	});

type MutableDescriptor = z.infer<typeof McpConformanceDescriptorSchema>;
type MutableReport = z.infer<typeof McpConformanceReportSchema>;

export type McpConformanceDescriptor = DeepReadonly<MutableDescriptor>;
export type McpConformanceReport = DeepReadonly<MutableReport>;
export type McpConformanceCheckReport = McpConformanceReport["checks"][number];
export type McpConformanceStatusCounts = McpConformanceReport["counts"];

export interface McpConformanceReportJsonOptions {
	readonly maximumBytes?: number;
}

export function parseMcpConformanceDescriptor(input: unknown): McpConformanceDescriptor {
	return deepFreeze(McpConformanceDescriptorSchema.parse(input));
}

export function parseMcpConformanceReport(
	input: unknown,
	options?: McpConformanceReportJsonOptions,
): McpConformanceReport {
	const report = McpConformanceReportSchema.parse(input);
	assertReportJsonSize(report, resolveMaximumJsonBytes(options));
	return deepFreeze(report);
}

export function serializeMcpConformanceReport(
	report: McpConformanceReport,
	options?: McpConformanceReportJsonOptions,
): string {
	const maximumBytes = resolveMaximumJsonBytes(options);
	const serialized = JSON.stringify(parseMcpConformanceReport(report, { maximumBytes }));
	assertJsonBytes(serialized, maximumBytes);
	return serialized;
}

export function parseMcpConformanceReportJson(
	input: string,
	options?: McpConformanceReportJsonOptions,
): McpConformanceReport {
	const maximumBytes = resolveMaximumJsonBytes(options);
	assertJsonBytes(input, maximumBytes);
	return parseMcpConformanceReport(JSON.parse(input) as unknown, { maximumBytes });
}

export function countMcpConformanceStatuses(
	checks: readonly { readonly status: McpConformanceCheckReport["status"] }[],
): McpConformanceStatusCounts {
	return deepFreeze(countStatuses(checks));
}

export function deriveMcpConformanceVerdict(
	completion: McpConformanceReport["completion"],
	counts: McpConformanceStatusCounts,
): McpConformanceReport["verdict"] {
	return deriveVerdict(completion, counts);
}

function countStatuses(
	checks: readonly { readonly status: McpConformanceCheckReport["status"] }[],
): Record<McpConformanceCheckReport["status"], number> {
	const counts = { pass: 0, warn: 0, fail: 0, skip: 0, error: 0 };
	for (const check of checks) counts[check.status] += 1;
	return counts;
}

function deriveVerdict(
	completion: McpConformanceReport["completion"],
	counts: Record<McpConformanceCheckReport["status"], number>,
): McpConformanceReport["verdict"] {
	if (completion !== "completed" || counts.error > 0) return "inconclusive";
	if (counts.fail > 0) return "fail";
	if (counts.warn > 0) return "warn";
	return counts.pass > 0 ? "pass" : "inconclusive";
}

function resolveMaximumJsonBytes(options: McpConformanceReportJsonOptions | undefined): number {
	const maximumBytes = options?.maximumBytes ?? MCP_CONFORMANCE_DEFAULT_LIMITS.maxJsonBytes;
	if (
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes <= 0 ||
		maximumBytes > MCP_CONFORMANCE_HARD_LIMITS.maxJsonBytes
	) {
		throw new RangeError(
			`maximumBytes must be a positive integer no greater than ${String(MCP_CONFORMANCE_HARD_LIMITS.maxJsonBytes)}.`,
		);
	}
	return maximumBytes;
}

function assertReportJsonSize(report: MutableReport, maximumBytes: number): void {
	assertJsonBytes(JSON.stringify(report), maximumBytes);
}

function assertJsonBytes(serialized: string, maximumBytes: number): void {
	if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
		throw new RangeError(
			`The conformance report JSON exceeds the configured ${String(maximumBytes)} byte safety limit.`,
		);
	}
}

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
	? Value
	: Value extends readonly (infer Entry)[]
		? readonly DeepReadonly<Entry>[]
		: Value extends object
			? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
			: Value;

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}
