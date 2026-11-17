import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import type { McpUpstreamAuthorizationServer } from "../upstream/mcp-oauth-upstream.ts";

/** Secrets and per-deployment values supplied to a provider preset. */
export interface McpUpstreamPresetInput {
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly scopes?: readonly string[];
}

/** Google via OIDC discovery. `access_type=offline`+`prompt=consent` are required for a refresh token. */
export function googleUpstream(input: McpUpstreamPresetInput): McpUpstreamAuthorizationServer {
	return {
		issuer: "https://accounts.google.com",
		clientId: input.clientId,
		...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
		scopes: input.scopes ?? ["openid", "email", "profile"],
		supportsPkce: true,
		extraAuthorizationParams: { access_type: "offline", prompt: "consent" },
	};
}

/** GitHub OAuth. PKCE is unsupported; steer to GitHub Apps for expiring tokens. */
export function githubUpstream(input: McpUpstreamPresetInput): McpUpstreamAuthorizationServer {
	return {
		issuer: "https://github.com",
		clientId: input.clientId,
		...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
		scopes: input.scopes ?? ["read:user"],
		supportsPkce: false,
		endpoints: {
			authorizationEndpoint: "https://github.com/login/oauth/authorize",
			tokenEndpoint: "https://github.com/login/oauth/access_token",
		},
	};
}

export interface McpAzurePresetInput extends McpUpstreamPresetInput {
	/** Required Entra tenant id — the `common`/`organizations` multiplexers are refused. */
	readonly tenantId: string;
}

/** Microsoft Entra ID, scoped to an explicit tenant so the issuer is fixed. */
export function azureUpstream(input: McpAzurePresetInput): McpUpstreamAuthorizationServer {
	const tenant = input.tenantId.trim().toLowerCase();
	if (
		tenant.length === 0 ||
		tenant === "common" ||
		tenant === "organizations" ||
		tenant === "consumers"
	) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"azureUpstream requires an explicit tenant id; the multi-tenant multiplexers are not allowed.",
		);
	}
	return {
		issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
		clientId: input.clientId,
		...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
		scopes: input.scopes ?? ["openid", "email", "profile", "offline_access"],
		supportsPkce: true,
	};
}

export interface McpGenericPresetInput extends McpUpstreamPresetInput {
	readonly issuer: string;
	readonly endpoints?: McpUpstreamAuthorizationServer["endpoints"];
	readonly allowedEndpointHosts?: readonly string[];
	readonly supportsPkce?: boolean;
}

/** A generic OIDC/OAuth upstream. Callers must supply the issuer and scopes explicitly. */
export function genericUpstream(input: McpGenericPresetInput): McpUpstreamAuthorizationServer {
	if (typeof input.issuer !== "string" || input.issuer.length === 0) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "genericUpstream requires an issuer.");
	}
	return {
		issuer: input.issuer,
		clientId: input.clientId,
		...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
		scopes: input.scopes ?? [],
		supportsPkce: input.supportsPkce ?? true,
		...(input.endpoints === undefined ? {} : { endpoints: input.endpoints }),
		...(input.allowedEndpointHosts === undefined
			? {}
			: { allowedEndpointHosts: input.allowedEndpointHosts }),
	};
}
