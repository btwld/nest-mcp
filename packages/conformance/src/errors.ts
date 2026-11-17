export const MCP_CONFORMANCE_CAPTURE_REJECTED = "MCP_CONFORMANCE_CAPTURE_REJECTED" as const;
export const MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED =
	"MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED" as const;
export const MCP_CONFORMANCE_CATALOG_REJECTED = "MCP_CONFORMANCE_CATALOG_REJECTED" as const;

export type McpConformanceCaptureErrorCode =
	| typeof MCP_CONFORMANCE_CAPTURE_REJECTED
	| typeof MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED
	| typeof MCP_CONFORMANCE_CATALOG_REJECTED;

/**
 * Bounded-capture failure raised before a hostile or oversized value reaches
 * canonicalization. Messages state a fixed structural reason and deliberately
 * never quote the rejected value, its keys, or the limit that was reached.
 */
export class McpConformanceCaptureError extends Error {
	readonly code: McpConformanceCaptureErrorCode;

	constructor(code: McpConformanceCaptureErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "McpConformanceCaptureError";
		this.code = code;
	}
}

export function captureRejectedError(
	reason: string,
	options?: ErrorOptions,
): McpConformanceCaptureError {
	return new McpConformanceCaptureError(
		MCP_CONFORMANCE_CAPTURE_REJECTED,
		`Captured values must be plain JSON data: ${reason}.`,
		options,
	);
}

export function captureLimitError(reason: string): McpConformanceCaptureError {
	return new McpConformanceCaptureError(
		MCP_CONFORMANCE_CAPTURE_LIMIT_EXCEEDED,
		`The captured value exceeds its ${reason} limit.`,
	);
}

export function catalogRejectedError(
	reason: string,
	options?: ErrorOptions,
): McpConformanceCaptureError {
	return new McpConformanceCaptureError(
		MCP_CONFORMANCE_CATALOG_REJECTED,
		`The MCP runtime catalog is invalid: ${reason}.`,
		options,
	);
}
