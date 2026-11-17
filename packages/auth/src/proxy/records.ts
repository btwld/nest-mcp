import { sha256Base64Url } from "../crypto/secrets.ts";

/** Namespaces every stored key by issuer so a shared store never collides across servers. */
export function issuerFingerprint(issuer: string): string {
	return sha256Base64Url(issuer).slice(0, 16);
}

export type McpOAuthRecordKind =
	"authz" | "code" | "code-spent" | "grant" | "refresh" | "refresh-spent" | "client" | "jti-deny";

/** `nest-mcp.oauth.v1:{issuerFp}:{kind}:{id}` — the only key shape written to any store. */
export function recordKey(issuerFp: string, kind: McpOAuthRecordKind, id: string): string {
	return `nest-mcp.oauth.v1:${issuerFp}:${kind}:${id}`;
}

/** The authorization transaction created at `/authorize`, taken at `/callback`. */
export interface McpAuthzRecord {
	readonly txId: string;
	readonly clientId: string;
	readonly clientKind: "cimd" | "registered";
	readonly clientName: string;
	readonly redirectUri: string;
	/** The downstream client's own `state`, echoed back verbatim. */
	readonly clientState?: string;
	readonly codeChallenge: string;
	readonly resource: string;
	readonly scope: readonly string[];
	readonly upstreamIssuer: string;
	/** Tier-B (proxy↔upstream) PKCE verifier; never the client's. */
	readonly upstreamCodeVerifier: string;
	readonly upstreamAuthorizationUrl: string;
	readonly upstreamNonce: string;
	/** sha256 of the __Host session-binding cookie value. */
	readonly sessionBindingHash: string;
	/** CSRF token echoed by the consent form. */
	readonly csrf: string;
	readonly createdAt: number;
}

/** A single-use authorization code, keyed by sha256(code); the code is never stored. */
export interface McpCodeRecord {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly resource: string;
	readonly scope: readonly string[];
	readonly grantId: string;
	readonly subject: string;
	readonly tenantId?: string;
}

/** The durable grant holding upstream tokens; mutated on refresh, never taken. */
export interface McpGrantRecord {
	readonly grantId: string;
	readonly clientId: string;
	readonly subject: string;
	readonly tenantId?: string;
	readonly resource: string;
	readonly scope: readonly string[];
	readonly upstream: {
		readonly accessToken: string;
		readonly refreshToken?: string;
		readonly expiresAt?: number;
	};
	readonly generation: number;
	readonly createdAt: number;
}

/** A refresh handle, keyed by sha256(handle); rotated on every use. */
export interface McpRefreshRecord {
	readonly grantId: string;
	readonly generation: number;
	readonly clientId: string;
}

/** A registered (DCR or preconfigured) client record. */
export interface McpStoredClientRecord {
	readonly clientId: string;
	readonly clientName: string;
	readonly redirectUris: readonly string[];
	readonly tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
	readonly clientSecretHash?: string;
	readonly scope?: string;
	readonly createdAt: number;
}

export function encodeRecord(record: unknown): string {
	return JSON.stringify(record);
}

// Callers supply the record type explicitly; the single-use generic is intentional.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function decodeRecord<T>(value: string | undefined): T | undefined {
	if (value === undefined) return undefined;
	try {
		// Records are serialized by encodeRecord; the caller asserts the record shape.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return JSON.parse(value) as T;
	} catch {
		return undefined;
	}
}
