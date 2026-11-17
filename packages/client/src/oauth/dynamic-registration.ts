import type { FetchLike } from "@modelcontextprotocol/client";

import type { McpClientOAuthBootstrapCandidate } from "./bootstrap.ts";
import type { McpClientOAuthClient } from "./protocol.ts";
import { isMcpClientOAuthScopeToken } from "./scope.ts";

const MAX_URL_LENGTH = 4_096;
const MAX_CLIENT_NAME_LENGTH = 256;
const MAX_CLIENT_ID_LENGTH = 2_048;
const MAX_CLIENT_SECRET_LENGTH = 8_192;
const MAX_REDIRECT_URI_COUNT = 16;
const MAX_CONTACT_COUNT = 16;
const MAX_METADATA_VALUE_LENGTH = 512;
const MAX_SCOPE_COUNT = 128;
const MAX_SCOPE_STRING_LENGTH = 4_096;
const MAX_RESPONSE_BODY_BYTES = 64 * 1_024;

/** Stable, secret-free failure categories for explicitly enabled legacy DCR. */
export const McpClientOAuthDynamicRegistrationErrorCode = {
	InvalidOptions: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_INVALID_OPTIONS",
	Unsupported: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_UNSUPPORTED",
	EndpointRejected: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_ENDPOINT_REJECTED",
	RegistrationRejected: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_REJECTED",
	ResponseInvalid: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_RESPONSE_INVALID",
	OutcomeUnknown: "MCP_CLIENT_OAUTH_DYNAMIC_REGISTRATION_OUTCOME_UNKNOWN",
} as const;

export type McpClientOAuthDynamicRegistrationErrorCode =
	(typeof McpClientOAuthDynamicRegistrationErrorCode)[keyof typeof McpClientOAuthDynamicRegistrationErrorCode];

/** Public errors contain no remote body, URL, client identifier, or host exception text. */
export class McpClientOAuthDynamicRegistrationError extends Error {
	readonly code: McpClientOAuthDynamicRegistrationErrorCode;
	/** Whether the registration POST was handed to the host fetch. */
	readonly requestDispatched: boolean;
	/** False after dispatch: retrying could create a second client registration. */
	readonly retrySafe: boolean;

	constructor(code: McpClientOAuthDynamicRegistrationErrorCode, requestDispatched = false) {
		super(dynamicRegistrationErrorMessage(code));
		this.name = "McpClientOAuthDynamicRegistrationError";
		this.code = code;
		this.requestDispatched = requestDispatched;
		this.retrySafe = !requestDispatched;
	}
}

export interface McpClientOAuthDynamicRegistrationEndpointPolicyInput {
	/** A disposable copy; mutation cannot change the request destination. */
	readonly endpoint: URL;
	readonly exactRegistrationEndpoint: string;
	readonly issuer: URL;
	/** Preserved exactly for issuer binding and RFC 9207 comparisons. */
	readonly exactIssuer: string;
	readonly serverUrl: URL;
	readonly resource: URL;
	readonly method: "POST";
	readonly credentialed: false;
	readonly signal?: AbortSignal;
}

/** Only literal `true` admits the single registration POST. */
export type McpClientOAuthDynamicRegistrationEndpointPolicy = (
	input: McpClientOAuthDynamicRegistrationEndpointPolicyInput,
) => boolean | PromiseLike<boolean>;

export interface McpClientOAuthDynamicRegistrationOptions {
	/**
	 * A host-owned SSRF-hardened fetch with DNS pinning, response byte/time limits, and no retries.
	 * This primitive additionally forces `redirect: "error"` and invokes it exactly once.
	 */
	readonly fetch: FetchLike;
	readonly endpointPolicy: McpClientOAuthDynamicRegistrationEndpointPolicy;
}

/** Narrow allowlist for a public authorization-code client's RFC 7591 request metadata. */
export interface McpClientOAuthDynamicRegistrationClientMetadata {
	readonly clientName: string;
	/** Explicit RFC 7591 application classification; never inferred from redirect URI shape. */
	readonly applicationType: "native" | "web";
	readonly redirectUris: readonly string[];
	readonly clientUri?: string;
	readonly contacts?: readonly string[];
	readonly softwareId?: string;
	readonly softwareVersion?: string;
}

export interface McpClientOAuthDynamicRegistrationInput {
	/** Must be the selected `ready.candidate` returned by `McpClientOAuthBootstrap`. */
	readonly candidate: McpClientOAuthBootstrapCandidate;
	readonly clientMetadata: McpClientOAuthDynamicRegistrationClientMetadata;
	readonly scopes?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface McpClientOAuthDynamicRegistrationResult {
	readonly issuer: string;
	/** Directly consumable by `McpClientOAuthProtocol.startAuthorization`. */
	readonly client: McpClientOAuthClient;
	/** Some legacy servers issue a non-confidential secret even to public clients. */
	readonly clientSecret?: string;
	readonly clientIdIssuedAt?: number;
	readonly clientSecretExpiresAt?: number;
	readonly registeredScopes?: readonly string[];
}

/**
 * Explicit compatibility primitive for deprecated Dynamic Client Registration.
 *
 * It is intentionally exported only from `@nest-mcp/client/oauth/dynamic-registration`; normal
 * strict OAuth imports cannot invoke it. The host owns persistence, encryption, tenant policy,
 * browser state, and the decision to opt into this legacy operation.
 */
export class McpClientOAuthDynamicRegistration {
	readonly #fetch: FetchLike;
	readonly #endpointPolicy: McpClientOAuthDynamicRegistrationEndpointPolicy;

	constructor(options: McpClientOAuthDynamicRegistrationOptions) {
		if (
			typeof options !== "object" ||
			options === null ||
			typeof options.fetch !== "function" ||
			typeof options.endpointPolicy !== "function"
		) {
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
		}
		this.#fetch = options.fetch;
		this.#endpointPolicy = options.endpointPolicy;
	}

	/**
	 * Performs one registration attempt. When a rejected error has `retrySafe === false`, the POST
	 * was already dispatched and the same logical registration must never be retried.
	 */
	async register(
		input: McpClientOAuthDynamicRegistrationInput,
	): Promise<McpClientOAuthDynamicRegistrationResult> {
		const operation = normalizeRegistrationInput(input);
		throwIfAborted(operation.signal);
		await this.#authorizeEndpoint(operation);
		throwIfAborted(operation.signal);

		const request = createRegistrationRequest(operation);
		let response: Response;
		try {
			// From this point onward any thrown failure is ambiguous: the AS may have registered the
			// client before the response was lost. Callers must not retry this logical operation.
			response = await this.#fetch(new URL(operation.registrationEndpoint), {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request),
				redirect: "error",
				...(operation.signal === undefined ? {} : { signal: operation.signal }),
			});
		} catch {
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.OutcomeUnknown, true);
		}

		if (
			response.redirected ||
			(response.url.length > 0 && !isExactResponseUrl(response.url, operation.registrationEndpoint))
		) {
			await discardResponse(response);
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected, true);
		}
		if (!response.ok) {
			await discardResponse(response);
			throw registrationError(
				McpClientOAuthDynamicRegistrationErrorCode.RegistrationRejected,
				true,
			);
		}

		try {
			const body = await readBoundedJson(response);
			return normalizeRegistrationResult(operation, body);
		} catch (error) {
			if (error instanceof McpClientOAuthDynamicRegistrationError) {
				throw registrationError(error.code, true);
			}
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid, true);
		}
	}

	async #authorizeEndpoint(operation: NormalizedRegistrationInput): Promise<void> {
		let admitted: unknown;
		try {
			admitted = await awaitWithSignal(
				Promise.resolve().then(() =>
					this.#endpointPolicy(
						Object.freeze({
							endpoint: new URL(operation.registrationEndpoint),
							exactRegistrationEndpoint: operation.registrationEndpoint,
							issuer: new URL(operation.issuer),
							exactIssuer: operation.issuer,
							serverUrl: new URL(operation.serverUrl),
							resource: new URL(operation.resource),
							method: "POST",
							credentialed: false,
							...(operation.signal === undefined ? {} : { signal: operation.signal }),
						}),
					),
				),
				operation.signal,
			);
		} catch {
			throwIfAborted(operation.signal);
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected);
		}
		throwIfAborted(operation.signal);
		if (admitted !== true) {
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected);
		}
	}
}

interface NormalizedRegistrationInput {
	readonly issuer: string;
	readonly serverUrl: string;
	readonly resource: string;
	readonly registrationEndpoint: string;
	readonly clientName: string;
	readonly redirectUris: readonly string[];
	readonly applicationType: "native" | "web";
	readonly clientUri?: string;
	readonly contacts?: readonly string[];
	readonly softwareId?: string;
	readonly softwareVersion?: string;
	readonly scopes?: readonly string[];
	readonly signal: AbortSignal | undefined;
}

function normalizeRegistrationInput(
	input: McpClientOAuthDynamicRegistrationInput,
): NormalizedRegistrationInput {
	if (typeof input !== "object" || input === null) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	const candidate = input.candidate;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof candidate.authority !== "object" ||
		candidate.authority === null
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	if (candidate.legacyDynamicRegistrationEndpoint === undefined) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.Unsupported);
	}
	if (
		!Array.isArray(candidate.authority.tokenEndpointAuthMethodsSupported) ||
		!candidate.authority.tokenEndpointAuthMethodsSupported.includes("none")
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.Unsupported);
	}
	const issuer = requireIssuer(candidate.authority.issuer);
	const serverUrl = requireHttpsUrl(candidate.authority.serverUrl, true).href;
	const resource = requireHttpsUrl(candidate.authority.resource, true).href;
	const registrationEndpoint = requireHttpsUrl(
		candidate.legacyDynamicRegistrationEndpoint,
		true,
	).href;
	const metadata = input.clientMetadata;
	if (typeof metadata !== "object" || metadata === null) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	const clientName = requireBoundedText(metadata.clientName, MAX_CLIENT_NAME_LENGTH);
	const redirectUris = normalizeRedirectUris(metadata.redirectUris);
	const applicationType = normalizeApplicationType(metadata.applicationType);
	if (applicationType === "web" && redirectUris.some(isLoopbackHttpRedirect)) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	const clientUri = normalizeOptionalHttpsUrl(metadata.clientUri);
	const contacts = normalizeOptionalTextList(metadata.contacts, MAX_CONTACT_COUNT);
	const softwareId = normalizeOptionalText(metadata.softwareId);
	const softwareVersion = normalizeOptionalText(metadata.softwareVersion);
	const scopes = normalizeOptionalScopes(input.scopes);
	return Object.freeze({
		issuer,
		serverUrl,
		resource,
		registrationEndpoint,
		clientName,
		redirectUris,
		applicationType,
		...(clientUri === undefined ? {} : { clientUri }),
		...(contacts === undefined ? {} : { contacts }),
		...(softwareId === undefined ? {} : { softwareId }),
		...(softwareVersion === undefined ? {} : { softwareVersion }),
		...(scopes === undefined ? {} : { scopes }),
		signal: input.signal,
	});
}

function createRegistrationRequest(input: NormalizedRegistrationInput): Record<string, unknown> {
	return {
		client_name: input.clientName,
		redirect_uris: [...input.redirectUris],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		application_type: input.applicationType,
		...(input.clientUri === undefined ? {} : { client_uri: input.clientUri }),
		...(input.contacts === undefined ? {} : { contacts: [...input.contacts] }),
		...(input.softwareId === undefined ? {} : { software_id: input.softwareId }),
		...(input.softwareVersion === undefined ? {} : { software_version: input.softwareVersion }),
		...(input.scopes === undefined ? {} : { scope: input.scopes.join(" ") }),
	};
}

function normalizeRegistrationResult(
	input: NormalizedRegistrationInput,
	value: unknown,
): McpClientOAuthDynamicRegistrationResult {
	if (!isPlainRecord(value)) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const clientId = requireRemoteBoundedText(value.client_id, MAX_CLIENT_ID_LENGTH);
	const clientSecret = normalizeRemoteOptionalSecret(value.client_secret);
	const redirectUris = normalizeRemoteStringList(value.redirect_uris, MAX_REDIRECT_URI_COUNT);
	if (!sameStrings(redirectUris, input.redirectUris)) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	if (value.application_type !== undefined && value.application_type !== input.applicationType) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	if (
		value.token_endpoint_auth_method !== undefined &&
		value.token_endpoint_auth_method !== "none"
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const responseTypes = normalizeRemoteOptionalStringList(value.response_types, 16);
	const grantTypes = normalizeRemoteOptionalStringList(value.grant_types, 16);
	if (
		(responseTypes !== undefined && !responseTypes.includes("code")) ||
		(grantTypes !== undefined && !grantTypes.includes("authorization_code"))
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const clientIdIssuedAt = normalizeRemoteOptionalTimestamp(value.client_id_issued_at);
	const clientSecretExpiresAt = normalizeRemoteOptionalTimestamp(value.client_secret_expires_at);
	const registeredScopes = normalizeRemoteOptionalScope(value.scope);
	return Object.freeze({
		issuer: input.issuer,
		client: Object.freeze({
			clientId,
			authentication: Object.freeze({ method: "none" }),
		}),
		...(clientSecret === undefined ? {} : { clientSecret }),
		...(clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt }),
		...(clientSecretExpiresAt === undefined ? {} : { clientSecretExpiresAt }),
		...(registeredScopes === undefined ? {} : { registeredScopes }),
	});
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		await discardResponse(response);
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const length = Number(declaredLength);
		if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BODY_BYTES) {
			await discardResponse(response);
			throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
		}
	}
	let body: string;
	try {
		body = await response.text();
	} catch {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	if (
		body.length === 0 ||
		body.length > MAX_RESPONSE_BODY_BYTES ||
		new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BODY_BYTES
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
}

async function discardResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// A known HTTP response remains rejected even if draining its untrusted body fails.
	}
}

function normalizeRedirectUris(values: readonly string[]): readonly string[] {
	if (!Array.isArray(values) || values.length === 0 || values.length > MAX_REDIRECT_URI_COUNT) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	const normalized = [...new Set(values.map(normalizeRedirectUri))];
	if (normalized.length !== values.length) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return Object.freeze(normalized);
}

function normalizeApplicationType(value: unknown): "native" | "web" {
	if (value !== "native" && value !== "web") {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return value;
}

function normalizeRedirectUri(value: string): string {
	const url = requireUrl(value);
	if (
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		(url.protocol !== "https:" && !isLoopbackHttpRedirect(url.href))
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return url.href;
}

function isLoopbackHttpRedirect(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") return true;
	const octets = host.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every(isDecimalOctet);
}

function isDecimalOctet(value: string): boolean {
	if (!/^\d{1,3}$/u.test(value)) return false;
	const parsed = Number(value);
	return parsed >= 0 && parsed <= 255 && String(parsed) === value;
}

function normalizeOptionalHttpsUrl(value: string | undefined): string | undefined {
	return value === undefined ? undefined : requireHttpsUrl(value, true).href;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : requireBoundedText(value, MAX_METADATA_VALUE_LENGTH);
}

function normalizeOptionalTextList(
	values: readonly string[] | undefined,
	maximumCount: number,
): readonly string[] | undefined {
	if (values === undefined) return undefined;
	if (!Array.isArray(values) || values.length === 0 || values.length > maximumCount) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	const normalized = values.map((value) => requireBoundedText(value, MAX_METADATA_VALUE_LENGTH));
	return Object.freeze(normalized);
}

function normalizeOptionalScopes(
	values: readonly string[] | undefined,
): readonly string[] | undefined {
	if (values === undefined) return undefined;
	if (!Array.isArray(values) || values.length > MAX_SCOPE_COUNT) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	if (values.length === 0) return undefined;
	const normalized = [...new Set(values)];
	for (const value of normalized) requireScopeToken(value);
	const scope = normalized.join(" ");
	if (scope.length > MAX_SCOPE_STRING_LENGTH) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return Object.freeze(normalized);
}

function normalizeRemoteOptionalScope(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SCOPE_STRING_LENGTH) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const scopes = value.split(" ");
	if (scopes.length > MAX_SCOPE_COUNT) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	for (const scope of scopes) requireRemoteScopeToken(scope);
	return Object.freeze([...new Set(scopes)]);
}

function normalizeRemoteStringList(value: unknown, maximumCount: number): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > maximumCount) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	const result: string[] = [];
	for (const item of value) {
		result.push(requireRemoteBoundedText(item, MAX_URL_LENGTH));
	}
	return Object.freeze(result);
}

function normalizeRemoteOptionalStringList(
	value: unknown,
	maximumCount: number,
): readonly string[] | undefined {
	return value === undefined ? undefined : normalizeRemoteStringList(value, maximumCount);
}

function normalizeRemoteOptionalSecret(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return requireRemoteBoundedText(value, MAX_CLIENT_SECRET_LENGTH);
}

function normalizeRemoteOptionalTimestamp(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	return value;
}

function requireIssuer(value: string): string {
	requireHttpsUrl(value, false);
	return value;
}

function requireHttpsUrl(value: string, query: boolean): URL {
	const url = requireUrl(value);
	if (
		url.protocol !== "https:" ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		(!query && url.search.length > 0)
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return url;
}

function requireUrl(value: string): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	try {
		return new URL(value);
	} catch {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
}

function requireBoundedText(value: string, maximumLength: number): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		containsControlCharacter(value)
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
	return value;
}

function requireRemoteBoundedText(value: unknown, maximumLength: number): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		containsControlCharacter(value)
	) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
	return value;
}

function requireScopeToken(value: string): void {
	if (!isMcpClientOAuthScopeToken(value)) {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions);
	}
}

function requireRemoteScopeToken(value: string): void {
	try {
		requireScopeToken(value);
	} catch {
		throw registrationError(McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExactResponseUrl(value: string, expected: string): boolean {
	try {
		return new URL(value).href === expected;
	} catch {
		return false;
	}
}

function awaitWithSignal<Value>(
	promise: PromiseLike<Value>,
	signal: AbortSignal | undefined,
): Promise<Value> {
	if (signal === undefined) return Promise.resolve(promise);
	signal.throwIfAborted();
	return new Promise<Value>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted();
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) {
			return true;
		}
	}
	return false;
}

function registrationError(
	code: McpClientOAuthDynamicRegistrationErrorCode,
	requestDispatched = false,
): McpClientOAuthDynamicRegistrationError {
	return new McpClientOAuthDynamicRegistrationError(code, requestDispatched);
}

function dynamicRegistrationErrorMessage(code: McpClientOAuthDynamicRegistrationErrorCode): string {
	switch (code) {
		case McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions:
			return "The dynamic registration options are invalid.";
		case McpClientOAuthDynamicRegistrationErrorCode.Unsupported:
			return "The selected OAuth authority does not advertise dynamic registration.";
		case McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected:
			return "The dynamic registration endpoint was rejected.";
		case McpClientOAuthDynamicRegistrationErrorCode.RegistrationRejected:
			return "The authorization server rejected dynamic registration.";
		case McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid:
			return "The dynamic registration response is invalid.";
		case McpClientOAuthDynamicRegistrationErrorCode.OutcomeUnknown:
			return "The dynamic registration outcome is unknown and must not be retried.";
		default:
			return "Dynamic registration failed.";
	}
}
