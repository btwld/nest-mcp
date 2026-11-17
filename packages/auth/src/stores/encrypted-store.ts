import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import type { McpOAuthStore } from "./store.types.ts";

/** One at-rest encryption key. The first entry is active (writes); all decrypt by id. */
export interface McpOAuthEncryptionKey {
	/** Stable identifier embedded in the envelope; selects the key on decrypt. */
	readonly id: string;
	/** Key material (>=32 bytes); an HKDF subkey is derived from it per purpose. */
	readonly secret: Uint8Array | string;
}

export interface McpEncryptedStoreOptions {
	readonly keys: readonly McpOAuthEncryptionKey[];
	/** Invoked when a stored value fails to decrypt (treated as missing / throws in strict mode). */
	readonly onDecryptFailure?: (key: string) => void;
	/**
	 * Fail closed: a present-but-undecryptable record throws
	 * `McpOAuthStoreDecryptError` instead of surfacing as missing. Use this for
	 * stores that back security decisions (e.g. revocation), so a tampered or
	 * key-rotated-away record cannot silently read as absent.
	 */
	readonly strict?: boolean;
}

/** Thrown by a strict encrypted store when a present record cannot be decrypted. */
export class McpOAuthStoreDecryptError extends Error {
	readonly code = "MCP_OAUTH_STORE_DECRYPT_FAILED";

	constructor(readonly storageKey: string) {
		super("Stored OAuth record could not be decrypted.");
		this.name = "McpOAuthStoreDecryptError";
	}
}

const ENVELOPE_VERSION = "v1";
const MIN_SECRET_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Wraps a store so values are encrypted at rest with AES-256-GCM. The envelope
 * is `v1.<keyId>.<iv>.<tag>.<ciphertext>` (all base64url), and the AEAD's
 * additional data binds the ciphertext to `<version>|<keyId>|<storageKey>` — so
 * a record cannot be relocated to a different key, and an attacker with
 * store-write access cannot move a high-privilege blob under another id.
 *
 * Key rotation: list the new key first (it becomes active for writes) while
 * keeping older keys for decryption. An unknown key id or a failed
 * authentication tag is reported to `onDecryptFailure` and surfaces as a
 * missing record — never as plaintext and never as a thrown error.
 */
export function withEncryptedValues(
	inner: McpOAuthStore,
	options: McpEncryptedStoreOptions,
): McpOAuthStore {
	if (!Array.isArray(options.keys) || options.keys.length === 0) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"withEncryptedValues requires at least one encryption key.",
		);
	}
	const keyById = new Map<string, Buffer>();
	for (const key of options.keys) {
		if (typeof key.id !== "string" || key.id.length === 0 || key.id.includes(".")) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				"Encryption key ids must be non-empty strings without a dot.",
			);
		}
		const secret =
			typeof key.secret === "string" ? Buffer.from(key.secret, "utf8") : Buffer.from(key.secret);
		if (secret.byteLength < MIN_SECRET_BYTES) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				`Encryption key "${key.id}" secret must be at least ${String(MIN_SECRET_BYTES)} bytes.`,
			);
		}
		if (keyById.has(key.id)) {
			throw new McpOAuthConfigError("INVALID_OPTIONS", `Duplicate encryption key id "${key.id}".`);
		}
		keyById.set(key.id, deriveKey(secret, key.id));
	}
	const activeId = options.keys[0]?.id;
	const activeKey = activeId === undefined ? undefined : keyById.get(activeId);
	if (activeId === undefined || activeKey === undefined) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "withEncryptedValues has no active key.");
	}
	const onFailure = options.onDecryptFailure ?? (() => undefined);
	const strict = options.strict === true;

	const decryptFor = (storageKey: string, envelope: string | undefined): string | undefined => {
		if (envelope === undefined) return undefined;
		const plaintext = decrypt(storageKey, envelope, keyById);
		if (plaintext === undefined) {
			onFailure(storageKey);
			// A present-but-undecryptable record is a tamper/rotation signal. In
			// strict mode raise it so a caller cannot mistake it for "absent".
			if (strict) throw new McpOAuthStoreDecryptError(storageKey);
			return undefined;
		}
		return plaintext;
	};

	return {
		get: async (key) => decryptFor(key, await inner.get(key)),
		set: async (key, value, opts) => inner.set(key, encrypt(key, value, activeId, activeKey), opts),
		setIfAbsent: async (key, value, opts) =>
			inner.setIfAbsent(key, encrypt(key, value, activeId, activeKey), opts),
		take: async (key) => decryptFor(key, await inner.take(key)),
		delete: async (key) => inner.delete(key),
	} satisfies McpOAuthStore;
}

function encrypt(storageKey: string, value: string, keyId: string, key: Buffer): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad(keyId, storageKey), "utf8"));
	const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		ENVELOPE_VERSION,
		keyId,
		iv.toString("base64url"),
		tag.toString("base64url"),
		ciphertext.toString("base64url"),
	].join(".");
}

function decrypt(
	storageKey: string,
	envelope: string,
	keyById: ReadonlyMap<string, Buffer>,
): string | undefined {
	const parts = envelope.split(".");
	if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) return undefined;
	const [, keyId = "", ivB64 = "", tagB64 = "", dataB64 = ""] = parts;
	const key = keyById.get(keyId);
	if (key === undefined) return undefined;
	const iv = Buffer.from(ivB64, "base64url");
	const tag = Buffer.from(tagB64, "base64url");
	// Pin the AEAD parameter widths: a short IV or a truncated tag (an
	// attacker-chosen 4-byte tag would cut forgery cost from 2^128 to 2^32) is
	// rejected outright, not passed to the cipher.
	if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) return undefined;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(Buffer.from(aad(keyId, storageKey), "utf8"));
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(Buffer.from(dataB64, "base64url")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		// Wrong key, tampered ciphertext, or a relocated record (AAD mismatch).
		return undefined;
	}
}

function aad(keyId: string, storageKey: string): string {
	return `nest-mcp.oauth.${ENVELOPE_VERSION}|${keyId}|${storageKey}`;
}

function deriveKey(secret: Buffer, keyId: string): Buffer {
	return Buffer.from(
		hkdfSync(
			"sha256",
			secret,
			Buffer.from(`nest-mcp.oauth.v1 storage ${keyId}`, "utf8"),
			Buffer.from("nest-mcp.oauth.v1 storage", "utf8"),
			KEY_BYTES,
		),
	);
}
