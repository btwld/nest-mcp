export type McpOAuthConfigErrorCode = "INVALID_OPTIONS" | "MISSING_DEPENDENCY";

/** Configuration-time failure; never carries request or token material. */
export class McpOAuthConfigError extends Error {
	constructor(
		readonly code: McpOAuthConfigErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "McpOAuthConfigError";
	}
}

export type McpClientIdMetadataFailure =
	| "disabled"
	| "malformed-client-id"
	| "host-not-allowed"
	| "blocked-address"
	| "redirect-not-allowed"
	| "http-status"
	| "content-type"
	| "too-large"
	| "timeout"
	| "invalid-document"
	| "throttled";

const FAILURE_TO_OAUTH_ERROR: Record<
	McpClientIdMetadataFailure,
	"invalid_client" | "temporarily_unavailable" | "server_error"
> = {
	disabled: "invalid_client",
	"malformed-client-id": "invalid_client",
	"host-not-allowed": "invalid_client",
	"blocked-address": "invalid_client",
	"redirect-not-allowed": "invalid_client",
	"http-status": "temporarily_unavailable",
	"content-type": "invalid_client",
	"too-large": "invalid_client",
	timeout: "temporarily_unavailable",
	"invalid-document": "invalid_client",
	throttled: "temporarily_unavailable",
};

/**
 * A Client ID Metadata Document could not be resolved or validated. The
 * message is always a fixed constant — attacker-controlled document content
 * is never reflected into errors or OAuth responses.
 */
export class McpClientIdMetadataError extends Error {
	readonly code = "MCP_CLIENT_ID_METADATA_REJECTED";
	readonly oauthError: "invalid_client" | "temporarily_unavailable" | "server_error";

	constructor(
		readonly failure: McpClientIdMetadataFailure,
		message: string,
		options?: ErrorOptions & {
			readonly oauthError?: "invalid_client" | "temporarily_unavailable" | "server_error";
		},
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "McpClientIdMetadataError";
		this.oauthError = options?.oauthError ?? FAILURE_TO_OAUTH_ERROR[failure];
	}
}
