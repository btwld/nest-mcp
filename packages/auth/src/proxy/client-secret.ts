import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 32;

/** Hashes a client secret with scrypt; format `scrypt$<saltB64url>$<hashB64url>`. */
export function hashClientSecret(secret: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(secret, salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Constant-time verification of a client secret against a stored scrypt hash. */
export function verifyClientSecret(secret: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(parts[1] ?? "", "base64url");
		expected = Buffer.from(parts[2] ?? "", "base64url");
	} catch {
		return false;
	}
	if (salt.byteLength === 0 || expected.byteLength !== SCRYPT_KEYLEN) return false;
	const actual = scryptSync(secret, salt, SCRYPT_KEYLEN);
	return timingSafeEqual(actual, expected);
}
