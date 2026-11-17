export const MCP_CONFORMANCE_DEFAULT_LIMITS = Object.freeze({
	checkTimeoutMs: 2_000,
	runTimeoutMs: 8_000,
	maxChecks: 64,
	maxFactsPerCheck: 32,
	maxFactStringLength: 256,
	maxJsonBytes: 1_048_576,
});

export const MCP_CONFORMANCE_HARD_LIMITS = Object.freeze({
	maxChecks: 128,
	maxCheckTimeoutMs: 30_000,
	maxRunTimeoutMs: 60_000,
	maxFactsPerCheck: 64,
	maxFactStringLength: 1_024,
	maxJsonBytes: 4_194_304,
});

/**
 * Conservative capture bounds for untrusted MCP payloads. They stay well inside
 * the canonicalizer's own fixed ceilings so a rejection happens before an
 * 8 MiB, 128-level, or 100,000-node canonical walk is ever attempted.
 */
export const MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS = Object.freeze({
	maxBytes: 262_144,
	maxDepth: 24,
	maxProperties: 8_192,
	maxStringBytes: 32_768,
	maxItems: 512,
});

export const MCP_CONFORMANCE_HARD_CAPTURE_LIMITS = Object.freeze({
	maxBytes: 4_194_304,
	maxDepth: 64,
	maxProperties: 65_536,
	maxStringBytes: 1_048_576,
	maxItems: 8_192,
});

/** Conservative defaults for a lossy, display-safe MCP `tools/call` result. */
export const MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS = Object.freeze({
	maxContentBlocks: 20,
	maxTextBytesPerBlock: 8_192,
	maxTextBytesTotal: 65_536,
	maxStructuredDepth: 8,
	maxStructuredNodes: 1_000,
	maxStructuredStringBytes: 16_384,
	maxStructuredSerializedBytes: 65_536,
	maxSummaryDescriptorLength: 128,
});

/** Fixed ceilings prevent a caller-supplied projection policy from becoming unbounded. */
export const MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS = Object.freeze({
	maxContentBlocks: 8_192,
	maxTextBytesPerBlock: 1_048_576,
	maxTextBytesTotal: 4_194_304,
	maxStructuredDepth: 64,
	maxStructuredNodes: 65_536,
	maxStructuredStringBytes: 1_048_576,
	maxStructuredSerializedBytes: 4_194_304,
	maxSummaryDescriptorLength: 4_096,
});

export interface McpToolResultProjectionLimits {
	/** Maximum content blocks retained in wire order. */
	readonly maxContentBlocks?: number;
	/** Maximum UTF-8 bytes retained from one text block. */
	readonly maxTextBytesPerBlock?: number;
	/** Maximum UTF-8 bytes retained across every text block. */
	readonly maxTextBytesTotal?: number;
	/** Maximum structured-content container depth, counting the root as depth zero. */
	readonly maxStructuredDepth?: number;
	/** Maximum structured-content containers and leaves retained in total. */
	readonly maxStructuredNodes?: number;
	/** Maximum UTF-8 bytes retained from one structured-content string or key. */
	readonly maxStructuredStringBytes?: number;
	/** Maximum serialized UTF-8 bytes admitted for the projected structured content. */
	readonly maxStructuredSerializedBytes?: number;
	/** Maximum code units retained from a non-text block descriptor. */
	readonly maxSummaryDescriptorLength?: number;
}

export interface ResolvedMcpToolResultProjectionLimits {
	readonly maxContentBlocks: number;
	readonly maxTextBytesPerBlock: number;
	readonly maxTextBytesTotal: number;
	readonly maxStructuredDepth: number;
	readonly maxStructuredNodes: number;
	readonly maxStructuredStringBytes: number;
	readonly maxStructuredSerializedBytes: number;
	readonly maxSummaryDescriptorLength: number;
}

export function resolveMcpToolResultProjectionLimits(
	input: McpToolResultProjectionLimits | undefined,
): Readonly<ResolvedMcpToolResultProjectionLimits> {
	return Object.freeze({
		maxContentBlocks: boundedPositiveInteger(
			input?.maxContentBlocks ?? MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxContentBlocks,
			"maxContentBlocks",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxContentBlocks,
		),
		maxTextBytesPerBlock: boundedPositiveInteger(
			input?.maxTextBytesPerBlock ?? MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxTextBytesPerBlock,
			"maxTextBytesPerBlock",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxTextBytesPerBlock,
		),
		maxTextBytesTotal: boundedPositiveInteger(
			input?.maxTextBytesTotal ?? MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxTextBytesTotal,
			"maxTextBytesTotal",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxTextBytesTotal,
		),
		maxStructuredDepth: boundedPositiveInteger(
			input?.maxStructuredDepth ?? MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxStructuredDepth,
			"maxStructuredDepth",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxStructuredDepth,
		),
		maxStructuredNodes: boundedPositiveInteger(
			input?.maxStructuredNodes ?? MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxStructuredNodes,
			"maxStructuredNodes",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxStructuredNodes,
		),
		maxStructuredStringBytes: boundedPositiveInteger(
			input?.maxStructuredStringBytes ??
				MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxStructuredStringBytes,
			"maxStructuredStringBytes",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxStructuredStringBytes,
		),
		maxStructuredSerializedBytes: boundedPositiveInteger(
			input?.maxStructuredSerializedBytes ??
				MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxStructuredSerializedBytes,
			"maxStructuredSerializedBytes",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxStructuredSerializedBytes,
		),
		maxSummaryDescriptorLength: boundedPositiveInteger(
			input?.maxSummaryDescriptorLength ??
				MCP_TOOL_RESULT_PROJECTION_DEFAULT_LIMITS.maxSummaryDescriptorLength,
			"maxSummaryDescriptorLength",
			MCP_TOOL_RESULT_PROJECTION_HARD_LIMITS.maxSummaryDescriptorLength,
		),
	});
}

export interface McpConformanceCaptureLimits {
	/** Maximum UTF-8 byte length of the canonical JSON text the capture would produce. */
	readonly maxBytes: number;
	/** Maximum nesting depth, counting the captured root as depth zero. */
	readonly maxDepth: number;
	/** Maximum total object properties and array entries across the whole value. */
	readonly maxProperties: number;
	/** Maximum unescaped UTF-8 byte length of any single string, keys included. */
	readonly maxStringBytes: number;
	/** Maximum entries in any single array. */
	readonly maxItems: number;
}

export type ResolvedMcpConformanceCaptureLimits = Readonly<McpConformanceCaptureLimits>;

export function resolveMcpConformanceCaptureLimits(
	input: McpConformanceCaptureLimits | undefined,
): ResolvedMcpConformanceCaptureLimits {
	return Object.freeze({
		maxBytes: boundedPositiveInteger(
			input?.maxBytes ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS.maxBytes,
			"maxBytes",
			MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxBytes,
		),
		maxDepth: boundedPositiveInteger(
			input?.maxDepth ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS.maxDepth,
			"maxDepth",
			MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxDepth,
		),
		maxProperties: boundedPositiveInteger(
			input?.maxProperties ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS.maxProperties,
			"maxProperties",
			MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxProperties,
		),
		maxStringBytes: boundedPositiveInteger(
			input?.maxStringBytes ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS.maxStringBytes,
			"maxStringBytes",
			MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxStringBytes,
		),
		maxItems: boundedPositiveInteger(
			input?.maxItems ?? MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS.maxItems,
			"maxItems",
			MCP_CONFORMANCE_HARD_CAPTURE_LIMITS.maxItems,
		),
	});
}

export interface McpConformanceLimits {
	readonly checkTimeoutMs?: number;
	readonly runTimeoutMs?: number;
	readonly maxChecks?: number;
	readonly maxFactsPerCheck?: number;
	readonly maxFactStringLength?: number;
	readonly maxJsonBytes?: number;
}

export interface ResolvedMcpConformanceLimits {
	readonly checkTimeoutMs: number;
	readonly runTimeoutMs: number;
	readonly maxChecks: number;
	readonly maxFactsPerCheck: number;
	readonly maxFactStringLength: number;
	readonly maxJsonBytes: number;
}

export function resolveMcpConformanceLimits(
	input: McpConformanceLimits | undefined,
): ResolvedMcpConformanceLimits {
	return Object.freeze({
		checkTimeoutMs: boundedPositiveInteger(
			input?.checkTimeoutMs ?? MCP_CONFORMANCE_DEFAULT_LIMITS.checkTimeoutMs,
			"checkTimeoutMs",
			MCP_CONFORMANCE_HARD_LIMITS.maxCheckTimeoutMs,
		),
		runTimeoutMs: boundedPositiveInteger(
			input?.runTimeoutMs ?? MCP_CONFORMANCE_DEFAULT_LIMITS.runTimeoutMs,
			"runTimeoutMs",
			MCP_CONFORMANCE_HARD_LIMITS.maxRunTimeoutMs,
		),
		maxChecks: boundedPositiveInteger(
			input?.maxChecks ?? MCP_CONFORMANCE_DEFAULT_LIMITS.maxChecks,
			"maxChecks",
			MCP_CONFORMANCE_HARD_LIMITS.maxChecks,
		),
		maxFactsPerCheck: boundedPositiveInteger(
			input?.maxFactsPerCheck ?? MCP_CONFORMANCE_DEFAULT_LIMITS.maxFactsPerCheck,
			"maxFactsPerCheck",
			MCP_CONFORMANCE_HARD_LIMITS.maxFactsPerCheck,
		),
		maxFactStringLength: boundedPositiveInteger(
			input?.maxFactStringLength ?? MCP_CONFORMANCE_DEFAULT_LIMITS.maxFactStringLength,
			"maxFactStringLength",
			MCP_CONFORMANCE_HARD_LIMITS.maxFactStringLength,
		),
		maxJsonBytes: boundedPositiveInteger(
			input?.maxJsonBytes ?? MCP_CONFORMANCE_DEFAULT_LIMITS.maxJsonBytes,
			"maxJsonBytes",
			MCP_CONFORMANCE_HARD_LIMITS.maxJsonBytes,
		),
	});
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new RangeError(`${name} must be a positive integer no greater than ${String(maximum)}.`);
	}
	return value;
}
