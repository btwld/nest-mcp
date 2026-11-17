import type { McpClientOAuthProtocolError } from "./protocol.ts";

const internalProtocolErrors = new WeakSet<object>();

/** Package-internal authenticity marker; intentionally not exported from the OAuth entry point. */
export function markInternalMcpClientOAuthProtocolError<
	ProtocolError extends McpClientOAuthProtocolError,
>(error: ProtocolError): ProtocolError {
	internalProtocolErrors.add(error);
	return error;
}

/** Distinguishes fixed, library-origin failures from public-constructor lookalikes. */
export function isInternalMcpClientOAuthProtocolError(
	error: unknown,
): error is McpClientOAuthProtocolError {
	return (
		error !== null &&
		(typeof error === "object" || typeof error === "function") &&
		internalProtocolErrors.has(error)
	);
}
