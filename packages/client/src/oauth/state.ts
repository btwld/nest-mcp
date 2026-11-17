import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const OAUTH_STATE_DIGEST_DOMAIN = "nest-mcp.client.oauth-state.v1\u0000";
const SHA_256_BYTES = 32;
const SHA_256_BASE64URL_LENGTH = 43;
const DEFAULT_STATE_ENTROPY_BYTES = 32;
const MIN_STATE_ENTROPY_BYTES = 16;
const MAX_STATE_ENTROPY_BYTES = 64;
const DEFAULT_PKCE_ENTROPY_BYTES = 32;
const MIN_PKCE_ENTROPY_BYTES = 32;
const MAX_PKCE_ENTROPY_BYTES = 96;
const MIN_PKCE_VERIFIER_LENGTH = 43;
const MAX_PKCE_VERIFIER_LENGTH = 128;

const CALLBACK_PARAMETER_LIMITS = {
	code: 4_096,
	state: 512,
	iss: 2_048,
	error: 256,
	error_description: 1_024,
	error_uri: 2_048,
} as const;

const RESERVED_CALLBACK_PARAMETERS = [
	"code",
	"state",
	"iss",
	"error",
	"error_description",
	"error_uri",
] as const satisfies readonly (keyof typeof CALLBACK_PARAMETER_LIMITS)[];
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/u;

/** Stable, secret-free failure categories for OAuth state and callback handling. */
export const McpOAuthStateErrorCode = {
	InvalidOptions: "MCP_OAUTH_STATE_INVALID_OPTIONS",
	InvalidCallback: "MCP_OAUTH_CALLBACK_INVALID",
	InvalidDigest: "MCP_OAUTH_STATE_DIGEST_INVALID",
	StateMismatch: "MCP_OAUTH_STATE_MISMATCH",
	StateExpired: "MCP_OAUTH_STATE_EXPIRED",
	StateNotYetValid: "MCP_OAUTH_STATE_NOT_YET_VALID",
	InvalidPkceVerifier: "MCP_OAUTH_PKCE_VERIFIER_INVALID",
} as const;

export type McpOAuthStateErrorCode =
	(typeof McpOAuthStateErrorCode)[keyof typeof McpOAuthStateErrorCode];

/** An OAuth state/protocol error whose message never includes callback or secret material. */
export class McpOAuthStateError extends Error {
	readonly code: McpOAuthStateErrorCode;

	constructor(code: McpOAuthStateErrorCode) {
		super(stateErrorMessage(code));
		this.name = "McpOAuthStateError";
		this.code = code;
	}
}

export interface McpOAuthStateGenerationOptions {
	/** CSPRNG bytes. The resulting base64url state is always between 22 and 86 characters. */
	readonly entropyBytes?: number;
}

export interface McpOAuthPkceGenerationOptions {
	/** CSPRNG bytes. The resulting verifier is always within RFC 7636's 43-128 character bound. */
	readonly entropyBytes?: number;
}

export interface McpOAuthStateValidationInput {
	/** State received from the authorization callback. */
	readonly actualState: string;
	/** Domain-separated SHA-256 digest retained with the transaction; never the plaintext state. */
	readonly expectedDigest: string;
	/** Transaction creation time as Unix epoch milliseconds. */
	readonly createdAtMs: number;
	/** Positive transaction lifetime in milliseconds. */
	readonly ttlMs: number;
	/** Injectable clock for deterministic validation. Defaults to `Date.now()`. */
	readonly nowMs?: number;
}

export interface McpOAuthCallbackSuccess {
	readonly kind: "success";
	readonly code: string;
	readonly state: string;
	readonly issuer?: string;
}

export interface McpOAuthCallbackError {
	readonly kind: "error";
	readonly error: string;
	readonly state: string;
	readonly issuer?: string;
}

export type McpOAuthCallbackParameters = McpOAuthCallbackSuccess | McpOAuthCallbackError;

export type McpOAuthCallbackParameterInput = URL | URLSearchParams;

/** Generates an unpredictable OAuth state value using Node's CSPRNG. */
export function createOAuthState(options: McpOAuthStateGenerationOptions = {}): string {
	const entropyBytes = options.entropyBytes ?? DEFAULT_STATE_ENTROPY_BYTES;
	assertEntropyBytes(entropyBytes, MIN_STATE_ENTROPY_BYTES, MAX_STATE_ENTROPY_BYTES);
	return randomBytes(entropyBytes).toString("base64url");
}

/**
 * Derives the opaque key used to look up an authorization transaction.
 * The domain prefix prevents the digest from being reused as an unscoped SHA-256 identifier.
 */
export function createOAuthStateLookupDigest(state: string): string {
	assertStateValue(state);
	return createHash("sha256")
		.update(OAUTH_STATE_DIGEST_DOMAIN, "utf8")
		.update(state, "utf8")
		.digest("base64url");
}

/**
 * Validates a callback state against a digest-only transaction record and its lifetime.
 * Both valid digests are decoded to fixed-size byte arrays before constant-time comparison.
 */
export function validateOAuthState(input: McpOAuthStateValidationInput): void {
	assertStateValue(input.actualState);
	const expectedDigest = decodeStateDigest(input.expectedDigest);
	const actualDigest = Buffer.from(createOAuthStateLookupDigest(input.actualState), "base64url");
	const matches = timingSafeEqual(actualDigest, expectedDigest);

	if (!matches) {
		throw new McpOAuthStateError(McpOAuthStateErrorCode.StateMismatch);
	}

	const nowMs = input.nowMs ?? Date.now();
	assertEpochMilliseconds(input.createdAtMs);
	assertEpochMilliseconds(nowMs);
	if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
		throw invalidOptionsError();
	}
	if (nowMs < input.createdAtMs) {
		throw new McpOAuthStateError(McpOAuthStateErrorCode.StateNotYetValid);
	}
	if (nowMs - input.createdAtMs >= input.ttlMs) {
		throw new McpOAuthStateError(McpOAuthStateErrorCode.StateExpired);
	}
}

/**
 * Parses an authorization callback query without normalizing opaque values.
 * Unknown extension parameters are ignored as required by OAuth; reserved parameters are strict.
 */
export function parseOAuthCallbackParameters(
	input: McpOAuthCallbackParameterInput,
): McpOAuthCallbackParameters {
	if (input instanceof URL && input.hash.length > 0) throw invalidCallbackError();
	const parameters = input instanceof URL ? input.searchParams : input;
	if (!(parameters instanceof URLSearchParams)) throw invalidCallbackError();

	for (const name of RESERVED_CALLBACK_PARAMETERS) {
		const values = parameters.getAll(name);
		if (values.length > 1) throw invalidCallbackError();
		if (values.length === 1) assertCallbackValue(values[0], CALLBACK_PARAMETER_LIMITS[name]);
	}

	const code = parameters.get("code");
	const state = parameters.get("state");
	const issuer = optionalCallbackValue(parameters, "iss");
	const error = parameters.get("error");

	if (state === null) throw invalidCallbackError();
	if ((code === null) === (error === null)) throw invalidCallbackError();

	if (code !== null) {
		if (parameters.has("error_description") || parameters.has("error_uri")) {
			throw invalidCallbackError();
		}
		return {
			kind: "success",
			code,
			state,
			...(issuer === undefined ? {} : { issuer }),
		};
	}

	if (error === null) throw invalidCallbackError();
	return {
		kind: "error",
		error,
		state,
		...(issuer === undefined ? {} : { issuer }),
	};
}

/** Generates an RFC 7636 code verifier using Node's CSPRNG. */
export function createPkceVerifier(options: McpOAuthPkceGenerationOptions = {}): string {
	const entropyBytes = options.entropyBytes ?? DEFAULT_PKCE_ENTROPY_BYTES;
	assertEntropyBytes(entropyBytes, MIN_PKCE_ENTROPY_BYTES, MAX_PKCE_ENTROPY_BYTES);
	return randomBytes(entropyBytes).toString("base64url");
}

/** Derives the RFC 7636 `S256` code challenge for a validated verifier. */
export function createPkceS256Challenge(verifier: string): string {
	if (
		typeof verifier !== "string" ||
		verifier.length < MIN_PKCE_VERIFIER_LENGTH ||
		verifier.length > MAX_PKCE_VERIFIER_LENGTH ||
		!PKCE_VERIFIER_PATTERN.test(verifier)
	) {
		throw new McpOAuthStateError(McpOAuthStateErrorCode.InvalidPkceVerifier);
	}
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function assertEntropyBytes(value: number, minimum: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw invalidOptionsError();
	}
}

function assertEpochMilliseconds(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw invalidOptionsError();
	}
}

function assertStateValue(state: string): void {
	if (
		typeof state !== "string" ||
		state.length < base64urlLength(MIN_STATE_ENTROPY_BYTES) ||
		state.length > base64urlLength(MAX_STATE_ENTROPY_BYTES) ||
		!BASE64URL_PATTERN.test(state)
	) {
		throw new McpOAuthStateError(McpOAuthStateErrorCode.InvalidCallback);
	}
}

function decodeStateDigest(value: string): Buffer {
	if (
		typeof value !== "string" ||
		value.length !== SHA_256_BASE64URL_LENGTH ||
		!BASE64URL_PATTERN.test(value)
	) {
		throw invalidDigestError();
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== SHA_256_BYTES || decoded.toString("base64url") !== value) {
		throw invalidDigestError();
	}
	return decoded;
}

function assertCallbackValue(
	value: string | undefined,
	maximumLength: number,
): asserts value is string {
	if (
		value === undefined ||
		value.length === 0 ||
		value.length > maximumLength ||
		containsControlCharacter(value)
	) {
		throw invalidCallbackError();
	}
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true;
		}
	}
	return false;
}

function optionalCallbackValue(parameters: URLSearchParams, name: "iss"): string | undefined {
	const value = parameters.get(name);
	return value === null ? undefined : value;
}

function base64urlLength(bytes: number): number {
	return Math.ceil((bytes * 8) / 6);
}

function invalidOptionsError(): McpOAuthStateError {
	return new McpOAuthStateError(McpOAuthStateErrorCode.InvalidOptions);
}

function invalidCallbackError(): McpOAuthStateError {
	return new McpOAuthStateError(McpOAuthStateErrorCode.InvalidCallback);
}

function invalidDigestError(): McpOAuthStateError {
	return new McpOAuthStateError(McpOAuthStateErrorCode.InvalidDigest);
}

function stateErrorMessage(code: McpOAuthStateErrorCode): string {
	switch (code) {
		case McpOAuthStateErrorCode.InvalidOptions:
			return "The OAuth state operation options are invalid.";
		case McpOAuthStateErrorCode.InvalidCallback:
			return "The OAuth callback parameters are invalid.";
		case McpOAuthStateErrorCode.InvalidDigest:
			return "The stored OAuth state digest is invalid.";
		case McpOAuthStateErrorCode.StateMismatch:
			return "The OAuth callback state does not match the authorization transaction.";
		case McpOAuthStateErrorCode.StateExpired:
			return "The OAuth authorization transaction has expired.";
		case McpOAuthStateErrorCode.StateNotYetValid:
			return "The OAuth authorization transaction is not yet valid.";
		case McpOAuthStateErrorCode.InvalidPkceVerifier:
			return "The PKCE verifier is invalid.";
		default:
			return "The OAuth state operation failed.";
	}
}
