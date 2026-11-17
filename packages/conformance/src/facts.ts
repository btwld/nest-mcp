import { MCP_CONFORMANCE_HARD_LIMITS } from "./limits.ts";
import type { McpConformanceFactValue } from "./types.ts";

const FACT_KEY = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/u;
const SENSITIVE_KEY =
	/(?:authorization|cookie|credential|password|secret|token|private[-_.]?key|api[-_.]?key)/iu;

export interface McpConformanceFactProjection {
	readonly facts: Readonly<Record<string, McpConformanceFactValue>>;
	readonly omittedCount: number;
}

export function projectMcpConformanceFacts(
	input: Readonly<Record<string, McpConformanceFactValue>> | undefined,
	options: { readonly maximum: number; readonly maximumStringLength: number },
): McpConformanceFactProjection {
	assertProjectionLimit(options.maximum, "maximum", MCP_CONFORMANCE_HARD_LIMITS.maxFactsPerCheck);
	assertProjectionLimit(
		options.maximumStringLength,
		"maximumStringLength",
		MCP_CONFORMANCE_HARD_LIMITS.maxFactStringLength,
	);
	if (input === undefined) return Object.freeze({ facts: Object.freeze({}), omittedCount: 0 });
	const entries = Object.entries(input).toSorted(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	const projected: Record<string, McpConformanceFactValue> = {};
	let omittedCount = 0;
	for (const [key, value] of entries) {
		if (
			Object.keys(projected).length >= options.maximum ||
			key.length > 64 ||
			!FACT_KEY.test(key) ||
			SENSITIVE_KEY.test(key) ||
			!isFactValue(value)
		) {
			omittedCount += 1;
			continue;
		}
		projected[key] =
			typeof value === "string" && value.length > options.maximumStringLength
				? value.slice(0, options.maximumStringLength)
				: value;
		if (typeof value === "string" && value.length > options.maximumStringLength) omittedCount += 1;
	}
	return Object.freeze({ facts: Object.freeze(projected), omittedCount });
}

function assertProjectionLimit(value: number, name: string, maximum: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new RangeError(`${name} must be a positive integer no greater than ${String(maximum)}.`);
	}
}

function isFactValue(value: unknown): value is McpConformanceFactValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}
