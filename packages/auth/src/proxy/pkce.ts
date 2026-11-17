import { createHash, timingSafeEqual } from "node:crypto";

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Verifies a client-supplied PKCE `code_verifier` against the stored S256
 * challenge (tier A, client↔proxy). The verifier charset/length is checked
 * before hashing, and the comparison is constant-time. `plain` is never
 * accepted — OAuth 2.1 and the MCP spec require S256.
 */
export function verifyPkceS256(codeVerifier: string, storedChallenge: string): boolean {
	if (typeof codeVerifier !== "string" || !CODE_VERIFIER_PATTERN.test(codeVerifier)) {
		return false;
	}
	const computed = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
	const a = Buffer.from(computed, "utf8");
	const b = Buffer.from(storedChallenge, "utf8");
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** True when a `code_challenge_method` value is the required S256. */
export function isS256Method(method: string | undefined): boolean {
	// Absent method defaults to `plain` in RFC 7636 — which we reject — so an
	// omitted method is treated as non-compliant unless explicitly S256.
	return method === "S256";
}

// A base64url-encoded SHA-256 digest is always exactly 43 unpadded chars.
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

/** True when `code_challenge` is a well-formed S256 challenge (43-char base64url). */
export function isValidS256Challenge(value: string): boolean {
	return S256_CHALLENGE_PATTERN.test(value);
}
