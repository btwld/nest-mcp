import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as cryptoSign,
	timingSafeEqual,
	verify as cryptoVerify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";

export type McpTokenSigningAlgorithm = "EdDSA" | "ES256" | "HS256";

export interface McpTokenSigningKeyInput {
	readonly alg: McpTokenSigningAlgorithm;
	/** Private key for EdDSA/ES256 (PEM string or KeyObject). */
	readonly privateKey?: KeyObject | string;
	/** Shared secret for HS256; must be at least 32 bytes. */
	readonly secret?: Uint8Array | string;
	/** Defaults to the RFC 7638 thumbprint prefix of the public JWK. */
	readonly kid?: string;
	readonly notBefore?: number;
	readonly notAfter?: number;
}

export interface McpTokenSigningKey {
	readonly kid: string;
	readonly alg: McpTokenSigningAlgorithm;
	readonly notBefore: number;
	readonly notAfter: number | undefined;
	readonly sign: (data: Uint8Array) => Buffer;
	readonly verify: (data: Uint8Array, signature: Uint8Array) => boolean;
	readonly publicJwk: Readonly<Record<string, unknown>> | undefined;
}

export interface McpTokenKeyRing {
	/** Exactly one writer: the first configured key. */
	activeKey(): McpTokenSigningKey;
	verificationKey(kid: string): McpTokenSigningKey | undefined;
	/** Public keys only; HS256 members are never published. */
	publicJwks(): Readonly<{ keys: readonly Readonly<Record<string, unknown>>[] }>;
}

export interface McpTokenKeyRingOptions {
	readonly keys: readonly McpTokenSigningKeyInput[];
	readonly now?: () => number;
}

const MIN_SECRET_BYTES = 32;

export function createMcpTokenKeyRing(options: McpTokenKeyRingOptions): McpTokenKeyRing {
	if (!Array.isArray(options.keys) || options.keys.length === 0) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"MCP token key ring requires at least one signing key.",
		);
	}
	const keys = options.keys.map((input) => materializeKey(input));
	const byKid = new Map(keys.map((key) => [key.kid, key]));
	if (byKid.size !== keys.length) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "MCP token key ids must be unique.");
	}
	const now = options.now ?? (() => Date.now());
	const nowSeconds = (): number => Math.floor(now() / 1_000);
	const isValid = (key: McpTokenSigningKey): boolean => {
		const at = nowSeconds();
		if (at < key.notBefore) return false;
		if (key.notAfter !== undefined && at >= key.notAfter) return false;
		return true;
	};
	return {
		// The active signer is the first key currently inside its validity window.
		activeKey: () => {
			const active = keys.find(isValid);
			if (active === undefined) {
				throw new McpOAuthConfigError(
					"INVALID_OPTIONS",
					"No signing key is currently within its validity window.",
				);
			}
			return active;
		},
		// Retired keys stop verifying once their window closes.
		verificationKey: (kid) => {
			const key = byKid.get(kid);
			return key !== undefined && isValid(key) ? key : undefined;
		},
		// Published JWKS excludes retired keys.
		publicJwks: () =>
			Object.freeze({
				keys: Object.freeze(
					keys
						.filter((key) => key.publicJwk !== undefined && isValid(key))
						.map((key) => key.publicJwk ?? {}),
				),
			}),
	};
}

/** Generates an ephemeral signing keypair; useful for tests and dev servers. */
export function generateMcpSigningKey(
	alg: Exclude<McpTokenSigningAlgorithm, "HS256"> = "EdDSA",
): McpTokenSigningKeyInput {
	const { privateKey } =
		alg === "EdDSA"
			? generateKeyPairSync("ed25519")
			: generateKeyPairSync("ec", { namedCurve: "P-256" });
	return { alg, privateKey };
}

export interface McpAccessTokenClaims {
	readonly iss: string;
	readonly aud: string;
	readonly sub: string;
	readonly client_id: string;
	/** Space-delimited scope string per RFC 9068. */
	readonly scope: string;
	readonly exp: number;
	readonly iat: number;
	readonly nbf: number;
	readonly jti: string;
	/** Grant handle binding the token to server-side upstream state. */
	readonly gid?: string;
	readonly tid?: string;
}

/** Signs an RFC 9068 `at+jwt` access token with the ring's active key. */
export function signMcpAccessToken(ring: McpTokenKeyRing, claims: McpAccessTokenClaims): string {
	const key = ring.activeKey();
	const header = { alg: key.alg, typ: "at+jwt", kid: key.kid };
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
	const signature = key.sign(Buffer.from(signingInput, "utf8"));
	return `${signingInput}.${signature.toString("base64url")}`;
}

export type McpAccessTokenVerifyFailure =
	| "malformed"
	| "unknown-kid"
	| "algorithm-mismatch"
	| "bad-signature"
	| "wrong-type"
	| "issuer-mismatch"
	| "expired"
	| "not-yet-valid"
	| "missing-claims";

export class McpAccessTokenError extends Error {
	readonly code = "MCP_ACCESS_TOKEN_REJECTED";

	constructor(
		readonly failure: McpAccessTokenVerifyFailure,
		message: string,
	) {
		super(message);
		this.name = "McpAccessTokenError";
	}
}

export interface McpAccessTokenVerifyOptions {
	readonly issuer: string;
	/** Allowed clock skew; bounded to two minutes. */
	readonly clockSkewSeconds?: number;
	readonly now?: () => number;
}

const MAX_HEADER_BYTES = 1_024;
const MAX_PAYLOAD_BYTES = 8_192;
const MAX_CLOCK_SKEW_SECONDS = 120;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

/** Resolves the allowed clock skew, failing closed on a non-finite/negative value. */
export function resolveClockSkewSeconds(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_CLOCK_SKEW_SECONDS;
	if (!Number.isFinite(raw) || raw < 0) {
		throw new McpAccessTokenError(
			"malformed",
			"clockSkewSeconds must be a finite, non-negative number.",
		);
	}
	return Math.min(raw, MAX_CLOCK_SKEW_SECONDS);
}

/**
 * Verifies signature, structure, and temporal claims. The algorithm is
 * pinned from the resolved key — never trusted from the token header — which
 * closes the classic alg-confusion downgrade.
 */
export function verifyMcpAccessToken(
	ring: McpTokenKeyRing,
	token: string,
	options: McpAccessTokenVerifyOptions,
): McpAccessTokenClaims {
	const segments = token.split(".");
	if (segments.length !== 3) throw new McpAccessTokenError("malformed", "Malformed token.");
	const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = segments;
	if (headerSegment.length > MAX_HEADER_BYTES || payloadSegment.length > MAX_PAYLOAD_BYTES) {
		throw new McpAccessTokenError("malformed", "Token segment exceeds size limits.");
	}
	const header = decodeSegment(headerSegment);
	if (header["typ"] !== "at+jwt") {
		throw new McpAccessTokenError("wrong-type", "Token is not an at+jwt access token.");
	}
	const kid = header["kid"];
	if (typeof kid !== "string") {
		throw new McpAccessTokenError("malformed", "Token header must carry a kid.");
	}
	const key = ring.verificationKey(kid);
	if (key === undefined) {
		throw new McpAccessTokenError("unknown-kid", "Token key is not in the verification ring.");
	}
	if (header["alg"] !== key.alg) {
		throw new McpAccessTokenError(
			"algorithm-mismatch",
			"Token algorithm does not match the resolved key.",
		);
	}
	// Reject a non-canonical signature encoding so AuthInfo.token is a stable
	// identity (no malleable trailing bits producing distinct-but-valid tokens).
	const signature = Buffer.from(signatureSegment, "base64url");
	if (signature.toString("base64url") !== signatureSegment) {
		throw new McpAccessTokenError("malformed", "Token signature is not canonical base64url.");
	}
	const valid = key.verify(Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8"), signature);
	if (!valid) throw new McpAccessTokenError("bad-signature", "Token signature is invalid.");
	const payload = decodeSegment(payloadSegment);
	const claims = extractClaims(payload);
	if (claims.iss !== options.issuer) {
		throw new McpAccessTokenError("issuer-mismatch", "Token issuer is not this server.");
	}
	const skew = resolveClockSkewSeconds(options.clockSkewSeconds);
	const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
	if (claims.nbf > nowSeconds + skew) {
		throw new McpAccessTokenError("not-yet-valid", "Token is not yet valid.");
	}
	if (claims.exp <= nowSeconds - skew) {
		throw new McpAccessTokenError("expired", "Token is expired.");
	}
	return claims;
}

function extractClaims(payload: Record<string, unknown>): McpAccessTokenClaims {
	const iss = payload["iss"];
	const aud = normalizeAudience(payload["aud"]);
	const sub = payload["sub"];
	const clientId = payload["client_id"];
	const scope = payload["scope"];
	const exp = payload["exp"];
	const iat = payload["iat"];
	const nbf = payload["nbf"];
	const jti = payload["jti"];
	if (
		typeof iss !== "string" ||
		aud === undefined ||
		typeof sub !== "string" ||
		typeof clientId !== "string" ||
		typeof scope !== "string" ||
		typeof exp !== "number" ||
		typeof iat !== "number" ||
		typeof nbf !== "number" ||
		typeof jti !== "string"
	) {
		throw new McpAccessTokenError("missing-claims", "Token is missing required claims.");
	}
	const gid = payload["gid"];
	const tid = payload["tid"];
	return {
		iss,
		aud,
		sub,
		client_id: clientId,
		scope,
		exp,
		iat,
		nbf,
		jti,
		...(typeof gid === "string" ? { gid } : {}),
		...(typeof tid === "string" ? { tid } : {}),
	};
}

function normalizeAudience(aud: unknown): string | undefined {
	if (typeof aud === "string") return aud;
	if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string") return aud[0];
	return undefined;
}

function decodeSegment(segment: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
	} catch {
		throw new McpAccessTokenError("malformed", "Token segment is not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new McpAccessTokenError("malformed", "Token segment must be a JSON object.");
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return parsed as Record<string, unknown>;
}

function base64UrlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function materializeKey(input: McpTokenSigningKeyInput): McpTokenSigningKey {
	const notBefore = input.notBefore ?? 0;
	const notAfter = input.notAfter;
	if (input.alg === "HS256") {
		const secret =
			typeof input.secret === "string" ? Buffer.from(input.secret, "utf8") : input.secret;
		if (secret === undefined || secret.byteLength < MIN_SECRET_BYTES) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				`HS256 signing keys require a secret of at least ${String(MIN_SECRET_BYTES)} bytes.`,
			);
		}
		const secretBuffer = Buffer.from(secret);
		const hmac = (data: Uint8Array): Buffer =>
			createHmac("sha256", secretBuffer).update(data).digest();
		return {
			alg: "HS256",
			kid: input.kid ?? deriveHmacKid(secretBuffer),
			notBefore,
			notAfter,
			sign: hmac,
			verify: (data, signature) => {
				const expected = hmac(data);
				return (
					expected.byteLength === signature.byteLength &&
					timingSafeEqual(expected, Buffer.from(signature))
				);
			},
			publicJwk: undefined,
		};
	}
	if (input.privateKey === undefined) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			`${input.alg} signing keys require a privateKey.`,
		);
	}
	const privateKey =
		typeof input.privateKey === "string" ? createPrivateKey(input.privateKey) : input.privateKey;
	const publicKey = createPublicKey(privateKey);
	// The supplied key material must match the declared alg, or verification would
	// silently fail (or, worse, a caller could declare ES256 over an unrelated key).
	const keyType = publicKey.asymmetricKeyType;
	const jwk = publicKey.export({ format: "jwk" });
	if (input.alg === "EdDSA" && keyType !== "ed25519" && keyType !== "ed448") {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"EdDSA signing keys require an Ed25519/Ed448 key.",
		);
	}
	if (input.alg === "ES256" && (keyType !== "ec" || jwk.crv !== "P-256")) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "ES256 signing keys require a P-256 EC key.");
	}
	const kid = input.kid ?? deriveJwkThumbprintKid(jwk);
	const digest = input.alg === "EdDSA" ? null : "sha256";
	const signKey =
		input.alg === "EdDSA" ? privateKey : { key: privateKey, dsaEncoding: "ieee-p1363" as const };
	const verifyKey =
		input.alg === "EdDSA" ? publicKey : { key: publicKey, dsaEncoding: "ieee-p1363" as const };
	return {
		alg: input.alg,
		kid,
		notBefore,
		notAfter,
		sign: (data) => cryptoSign(digest, data, signKey),
		verify: (data, signature) => {
			try {
				return cryptoVerify(digest, data, verifyKey, signature);
			} catch {
				return false;
			}
		},
		publicJwk: Object.freeze({ ...jwk, kid, alg: input.alg, use: "sig" }),
	};
}

/** RFC 7638 thumbprint prefix, deterministic across restarts and replicas. */
function deriveJwkThumbprintKid(jwk: {
	readonly kty?: string;
	readonly crv?: string;
	readonly x?: string;
	readonly y?: string;
}): string {
	const members =
		jwk.kty === "OKP"
			? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
			: { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
	return createHash("sha256")
		.update(JSON.stringify(members), "utf8")
		.digest("base64url")
		.slice(0, 16);
}

function deriveHmacKid(secret: Buffer): string {
	return createHash("sha256")
		.update("nest-mcp.oauth.v1 hs256 kid")
		.update(secret)
		.digest("base64url")
		.slice(0, 16);
}
