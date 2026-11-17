import {
	discoverAuthorizationServerMetadata,
	exchangeAuthorization,
	refreshAuthorization,
	startAuthorization,
} from "@modelcontextprotocol/client";
import type {
	AuthorizationServerMetadata,
	FetchLike,
	OAuthTokens,
} from "@modelcontextprotocol/client";
import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import { createSsrfGuardedFetch } from "../cimd/ssrf-fetch.ts";
import type { McpFetchLike } from "../cimd/ssrf-fetch.ts";

/** Upstream authorization-server configuration for the proxy. */
export interface McpUpstreamAuthorizationServer {
	/** Exact RFC 8414 issuer string; validated against discovery metadata. */
	readonly issuer: string;
	/** The proxy's own client id at the upstream. */
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly scopes: readonly string[];
	/** Static endpoints when discovery is not used. */
	readonly endpoints?: {
		readonly authorizationEndpoint: string;
		readonly tokenEndpoint: string;
	};
	/** Extra hostnames (besides the issuer's registrable domain) allowed to host endpoints. */
	readonly allowedEndpointHosts?: readonly string[];
	/** Parameters merged into the upstream authorization request; reserved keys are refused. */
	readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
	readonly supportsPkce?: boolean;
}

const RESERVED_AUTHORIZATION_PARAMS = new Set([
	"client_id",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
	"code_challenge",
	"code_challenge_method",
	"resource",
	"nonce",
	"request",
	"request_uri",
	"prompt",
	"response_mode",
]);

export interface McpUpstreamStartResult {
	readonly authorizationUrl: string;
	readonly codeVerifier: string;
}

export interface McpUpstreamAdapterOptions {
	readonly upstream: McpUpstreamAuthorizationServer;
	/** Guarded fetch; defaults to an SSRF-hardened HTTPS fetch. */
	readonly fetch?: McpFetchLike;
	readonly discoveryTtlMs?: number;
	readonly now?: () => number;
}

const DEFAULT_DISCOVERY_TTL_MS = 300_000;

/**
 * Thin adapter over the official client SDK's OAuth helpers for the upstream
 * (proxy↔IdP) leg. It validates discovered metadata against the configured
 * issuer and an endpoint-host policy before any secret is sent, and coalesces
 * concurrent discovery.
 */
export class McpUpstreamAdapter {
	readonly #upstream: McpUpstreamAuthorizationServer;
	readonly #fetch: FetchLike;
	readonly #discoveryTtlMs: number;
	readonly #now: () => number;
	#cached: { metadata: AuthorizationServerMetadata; expiresAt: number } | undefined;
	#inFlight: Promise<AuthorizationServerMetadata> | undefined;

	constructor(options: McpUpstreamAdapterOptions) {
		this.#upstream = options.upstream;
		// The guarded fetch is a structural subset of the SDK's FetchLike.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		this.#fetch = (options.fetch ?? createSsrfGuardedFetch()) as FetchLike;
		this.#discoveryTtlMs = options.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS;
		this.#now = options.now ?? Date.now;
		for (const key of Object.keys(options.upstream.extraAuthorizationParams ?? {})) {
			if (RESERVED_AUTHORIZATION_PARAMS.has(key)) {
				throw new McpOAuthConfigError(
					"INVALID_OPTIONS",
					`Upstream extraAuthorizationParams must not set the reserved parameter "${key}".`,
				);
			}
		}
	}

	get issuer(): string {
		return this.#upstream.issuer;
	}

	/** The proxy's own client id at the upstream; the expected `aud` of an id_token. */
	get clientId(): string {
		return this.#upstream.clientId;
	}

	async #metadata(): Promise<AuthorizationServerMetadata> {
		const cached = this.#cached;
		if (cached !== undefined && cached.expiresAt > this.#now()) return cached.metadata;
		if (this.#inFlight !== undefined) return this.#inFlight;
		this.#inFlight = this.#discover().finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	async #discover(): Promise<AuthorizationServerMetadata> {
		const endpoints = this.#upstream.endpoints;
		if (endpoints !== undefined) {
			const metadata = {
				issuer: this.#upstream.issuer,
				authorization_endpoint: endpoints.authorizationEndpoint,
				token_endpoint: endpoints.tokenEndpoint,
				response_types_supported: ["code"],
			} as AuthorizationServerMetadata;
			this.#assertEndpoints(metadata);
			this.#cached = { metadata, expiresAt: this.#now() + this.#discoveryTtlMs };
			return metadata;
		}
		const metadata = await discoverAuthorizationServerMetadata(this.#upstream.issuer, {
			fetchFn: this.#fetch,
		});
		if (metadata === undefined) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				"Upstream authorization-server metadata could not be discovered.",
			);
		}
		if (metadata.issuer !== this.#upstream.issuer) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				"Discovered upstream issuer does not match the configured issuer.",
			);
		}
		this.#assertEndpoints(metadata);
		this.#cached = { metadata, expiresAt: this.#now() + this.#discoveryTtlMs };
		return metadata;
	}

	#assertEndpoints(metadata: AuthorizationServerMetadata): void {
		const issuerHost = new URL(this.#upstream.issuer).hostname;
		const allowed = new Set([issuerHost, ...(this.#upstream.allowedEndpointHosts ?? [])]);
		for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
			if (typeof endpoint !== "string") continue;
			const url = new URL(endpoint);
			if (url.protocol !== "https:") {
				throw new McpOAuthConfigError("INVALID_OPTIONS", "Upstream endpoints must use https.");
			}
			if (!isSameSiteOrAllowed(url.hostname, issuerHost, allowed)) {
				throw new McpOAuthConfigError(
					"INVALID_OPTIONS",
					`Upstream endpoint host "${url.hostname}" is not permitted for issuer "${issuerHost}".`,
				);
			}
		}
	}

	/** Builds the upstream authorization URL and tier-B PKCE verifier. */
	async startAuthorization(input: {
		readonly redirectUri: string;
		readonly state: string;
		readonly resource: URL;
	}): Promise<McpUpstreamStartResult> {
		const metadata = await this.#metadata();
		const result = await startAuthorization(this.#upstream.issuer, {
			metadata,
			clientInformation: this.#clientInformation(),
			redirectUrl: input.redirectUri,
			scope: this.#upstream.scopes.join(" "),
			state: input.state,
			resource: input.resource,
		});
		const authorizationUrl = this.#withExtraParams(result.authorizationUrl);
		return { authorizationUrl: authorizationUrl.href, codeVerifier: result.codeVerifier };
	}

	/** Redeems the upstream authorization code (validates RFC 9207 `iss`). */
	async exchangeCode(input: {
		readonly authorizationCode: string;
		readonly codeVerifier: string;
		readonly redirectUri: string;
		readonly resource: URL;
		readonly iss?: string;
	}): Promise<OAuthTokens> {
		const metadata = await this.#metadata();
		return exchangeAuthorization(this.#upstream.issuer, {
			metadata,
			clientInformation: this.#clientInformation(),
			authorizationCode: input.authorizationCode,
			codeVerifier: input.codeVerifier,
			redirectUri: input.redirectUri,
			resource: input.resource,
			fetchFn: this.#fetch,
			...(input.iss === undefined ? {} : { iss: input.iss }),
		});
	}

	/** Refreshes the upstream tokens, preserving the refresh token when unchanged. */
	async refresh(input: {
		readonly refreshToken: string;
		readonly resource: URL;
	}): Promise<OAuthTokens> {
		const metadata = await this.#metadata();
		return refreshAuthorization(this.#upstream.issuer, {
			metadata,
			clientInformation: this.#clientInformation(),
			refreshToken: input.refreshToken,
			resource: input.resource,
			fetchFn: this.#fetch,
		});
	}

	#clientInformation(): { client_id: string; client_secret?: string } {
		return {
			client_id: this.#upstream.clientId,
			...(this.#upstream.clientSecret === undefined
				? {}
				: { client_secret: this.#upstream.clientSecret }),
		};
	}

	#withExtraParams(url: URL): URL {
		const extra = this.#upstream.extraAuthorizationParams;
		if (extra === undefined) return url;
		const next = new URL(url.href);
		for (const [key, value] of Object.entries(extra)) next.searchParams.set(key, value);
		return next;
	}
}

/**
 * Endpoint host is admitted only if it is the issuer host itself, a true
 * subdomain of the issuer host, or an explicit allowlist entry. A two-label
 * "registrable domain" heuristic is deliberately avoided: without a Public
 * Suffix List it would treat `attacker.co.uk` and `victim.co.uk` as same-site,
 * letting a tampered discovery document steer the client secret off-domain.
 */
function isSameSiteOrAllowed(
	host: string,
	issuerHost: string,
	allowed: ReadonlySet<string>,
): boolean {
	if (allowed.has(host)) return true;
	return host === issuerHost || host.endsWith(`.${issuerHost}`);
}
