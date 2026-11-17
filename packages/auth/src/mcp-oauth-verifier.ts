import { checkResourceAllowed, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { McpOAuthConfigError } from "./mcp-oauth.errors.ts";
import { verifyMcpAccessToken } from "./jwt/issuer.ts";
import type { McpAccessTokenClaims, McpTokenKeyRing } from "./jwt/issuer.ts";
import type { MaybePromise } from "./stores/store.types.ts";

export interface McpProxyTokenVerifierOptions {
	readonly ring: McpTokenKeyRing;
	/** Exact issuer string minted into `iss`; compared without normalization. */
	readonly issuer: string;
	/** Canonical resource URLs this server answers for; `aud` must match one. */
	readonly resources: readonly (URL | string)[];
	readonly clockSkewSeconds?: number;
	/** Opt-in immediate revocation, e.g. a `jti-deny` store lookup. */
	readonly isRevoked?: (jti: string, claims: McpAccessTokenClaims) => MaybePromise<boolean>;
	readonly now?: () => number;
}

const INVALID_TOKEN_MESSAGE = "Invalid access token.";

/**
 * Verifies access tokens minted by this deployment's own key ring and
 * projects them onto the SDK's `AuthInfo`. Every rejection is the same
 * generic `invalid_token` — failures never explain themselves to callers.
 *
 * `extra.claims` carries only the allowlisted `{sub, tid}` pair (frozen);
 * raw upstream claims never reach handler context or principals.
 */
export function createMcpProxyTokenVerifier(
	options: McpProxyTokenVerifierOptions,
): OAuthTokenVerifier {
	if (options.resources.length === 0) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"MCP proxy token verifier requires at least one resource URL.",
		);
	}
	const resources = options.resources.map((resource) => new URL(resource).href);
	return {
		verifyAccessToken: async (token) => {
			let claims: McpAccessTokenClaims;
			try {
				claims = verifyMcpAccessToken(options.ring, token, {
					issuer: options.issuer,
					...(options.clockSkewSeconds === undefined
						? {}
						: { clockSkewSeconds: options.clockSkewSeconds }),
					...(options.now === undefined ? {} : { now: options.now }),
				});
			} catch {
				throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID_TOKEN_MESSAGE);
			}
			const audienceAllowed = resources.some((configuredResource) =>
				checkResourceAllowed({ requestedResource: claims.aud, configuredResource }),
			);
			if (!audienceAllowed) {
				throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID_TOKEN_MESSAGE);
			}
			if (options.isRevoked !== undefined && (await options.isRevoked(claims.jti, claims))) {
				throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID_TOKEN_MESSAGE);
			}
			return toAuthInfo(token, claims);
		},
	};
}

function toAuthInfo(token: string, claims: McpAccessTokenClaims): AuthInfo {
	return {
		token,
		clientId: claims.client_id,
		scopes: claims.scope.length === 0 ? [] : claims.scope.split(" "),
		expiresAt: claims.exp,
		resource: new URL(claims.aud),
		extra: {
			claims: Object.freeze({
				sub: claims.sub,
				...(claims.tid === undefined ? {} : { tid: claims.tid }),
				...(claims.gid === undefined ? {} : { gid: claims.gid }),
			}),
		},
	};
}

export interface McpJwksTokenVerifierOptions {
	/** JWKS endpoint of the external authorization server. Operator-supplied config. */
	readonly jwksUri: string;
	/** Exact expected `iss` value. */
	readonly issuer: string;
	/** Canonical resource URL enforced against `aud`. */
	readonly resource: URL | string;
	/** Explicit signature-algorithm allowlist; never derived from tokens. */
	readonly algorithms?: readonly string[];
	readonly clockSkewSeconds?: number;
}

const DEFAULT_JWKS_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;

/**
 * Bearer verifier for deployments fronting an external authorization server
 * that publishes JWKS. Requires the optional `jose` peer dependency; when it
 * is absent, verification fails closed with a configuration error.
 */
export function createJwksTokenVerifier(options: McpJwksTokenVerifierOptions): OAuthTokenVerifier {
	const resource = new URL(options.resource).href;
	const algorithms = [...(options.algorithms ?? DEFAULT_JWKS_ALGORITHMS)];
	let remoteJwks: ReturnType<(typeof import("jose"))["createRemoteJWKSet"]> | undefined;
	let joseModule: typeof import("jose") | undefined;

	const loadJose = async (): Promise<typeof import("jose")> => {
		if (joseModule !== undefined) return joseModule;
		try {
			joseModule = await import("jose");
		} catch (cause) {
			throw new McpOAuthConfigError(
				"MISSING_DEPENDENCY",
				'createJwksTokenVerifier requires the optional "jose" peer dependency.',
				{ cause },
			);
		}
		return joseModule;
	};

	return {
		verifyAccessToken: async (token) => {
			const jose = await loadJose();
			remoteJwks ??= jose.createRemoteJWKSet(new URL(options.jwksUri));
			let payload: Awaited<ReturnType<(typeof import("jose"))["jwtVerify"]>>["payload"];
			try {
				({ payload } = await jose.jwtVerify(token, remoteJwks, {
					issuer: options.issuer,
					algorithms,
					clockTolerance: options.clockSkewSeconds ?? 30,
				}));
			} catch {
				throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID_TOKEN_MESSAGE);
			}
			const audiences = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
			const audienceAllowed = audiences.some((audience) =>
				checkResourceAllowed({ requestedResource: audience, configuredResource: resource }),
			);
			if (!audienceAllowed || typeof payload.exp !== "number") {
				throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID_TOKEN_MESSAGE);
			}
			const clientId = payload["client_id"] ?? payload["azp"];
			const scope = payload["scope"];
			return {
				token,
				clientId: typeof clientId === "string" ? clientId : "",
				scopes: typeof scope === "string" && scope.length > 0 ? scope.split(" ") : [],
				expiresAt: payload.exp,
				resource: new URL(resource),
				...(typeof payload.sub === "string"
					? { extra: { claims: Object.freeze({ sub: payload.sub }) } }
					: {}),
			};
		},
	};
}
