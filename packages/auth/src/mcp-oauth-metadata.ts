import { OAuthMetadataSchema } from "@modelcontextprotocol/core";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { McpOAuthConfigError } from "./mcp-oauth.errors.ts";

export interface McpAuthorizationServerMetadataInput {
	readonly issuer: string;
	readonly basePath?: string;
	readonly scopesSupported?: readonly string[];
	/** True when the proxy resolves URL client_ids as Client ID Metadata Documents. */
	readonly clientIdMetadataDocumentSupported?: boolean;
	/** True when the proxy exposes a Dynamic Client Registration endpoint. */
	readonly registrationSupported?: boolean;
}

/**
 * Builds RFC 8414 authorization-server metadata for the proxy, validated
 * against the SDK's `OAuthMetadataSchema`. Endpoints are rooted at the issuer
 * origin plus the configured base path.
 */
export function buildMcpAuthorizationServerMetadata(
	input: McpAuthorizationServerMetadataInput,
): OAuthMetadata {
	const issuer = new URL(input.issuer);
	const base = normalizeBasePath(input.basePath);
	const endpoint = (path: string): string => new URL(`${base}${path}`, issuer).href;
	const metadata: Record<string, unknown> = {
		issuer: input.issuer.replace(/\/$/, ""),
		authorization_endpoint: endpoint("/oauth/authorize"),
		token_endpoint: endpoint("/oauth/token"),
		jwks_uri: new URL("/.well-known/jwks.json", issuer).href,
		response_types_supported: ["code"],
		grant_types_supported: [
			"authorization_code",
			"refresh_token",
			"urn:ietf:params:oauth:grant-type:token-exchange",
		],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: input.clientIdMetadataDocumentSupported === true,
		...(input.scopesSupported === undefined
			? {}
			: { scopes_supported: [...input.scopesSupported] }),
		...(input.registrationSupported === true
			? { registration_endpoint: endpoint("/oauth/register") }
			: {}),
	};
	const parsed = OAuthMetadataSchema.safeParse(metadata);
	if (!parsed.success) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"Constructed authorization-server metadata is invalid.",
			{ cause: parsed.error },
		);
	}
	return parsed.data;
}

function normalizeBasePath(basePath: string | undefined): string {
	if (basePath === undefined || basePath === "" || basePath === "/") return "";
	const trimmed = basePath.startsWith("/") ? basePath : `/${basePath}`;
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
