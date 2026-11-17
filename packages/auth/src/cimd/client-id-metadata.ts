import { McpClientIdMetadataError } from "../mcp-oauth.errors.ts";
import { createNodeDocumentFetcher, isBlockedDocumentAddress } from "./ssrf-fetch.ts";
import { McpDocumentFetchError } from "./ssrf-fetch.ts";
import type { McpHttpDocumentFetcher } from "./ssrf-fetch.ts";
import { isIP } from "node:net";

/** Frozen, validated projection of a Client ID Metadata Document. */
export interface McpClientIdMetadata {
	readonly clientId: string;
	readonly clientName: string;
	readonly redirectUris: readonly string[];
	readonly scope?: string;
	readonly tokenEndpointAuthMethod: "none" | "private_key_jwt";
	readonly jwksUri?: string;
	readonly clientUri?: string;
	readonly logoUri?: string;
	/** True when every registered redirect URI is loopback; consent must warn. */
	readonly loopbackOnly: boolean;
	readonly resolvedAt: number;
	readonly expiresAt: number;
}

export interface McpClientIdMetadataResolver {
	resolve(
		clientId: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<McpClientIdMetadata>;
}

export interface McpClientIdMetadataResolverOptions {
	/** Exact hostnames, or `.suffix.example` entries matching any subdomain. Unset admits any public host. */
	readonly allowedHosts?: readonly string[];
	/** CIMD §3 says client_id URLs SHOULD NOT carry a query; off by default. */
	readonly allowQueryInClientId?: boolean;
	/** Allow a non-443 port in the client_id (test/dev only); off by default. */
	readonly allowNonDefaultPort?: boolean;
	/** Max requests queued for an outbound fetch slot before shedding load. */
	readonly maxQueuedFetches?: number;
	/** Hard response cap. The spec recommends documents stay under 5 KB. */
	readonly maxDocumentBytes?: number;
	readonly fetchTimeoutMs?: number;
	readonly defaultCacheTtlMs?: number;
	readonly minCacheTtlMs?: number;
	readonly maxCacheTtlMs?: number;
	/** LRU bound; safe to evict because entries are re-fetchable. */
	readonly maxCacheEntries?: number;
	readonly maxConcurrentFetches?: number;
	/** Failures per host inside the window before the breaker opens. */
	readonly failureThreshold?: number;
	readonly failureWindowMs?: number;
	readonly cooldownMs?: number;
	readonly fetcher?: McpHttpDocumentFetcher;
	readonly now?: () => number;
}

const MAX_CLIENT_ID_BYTES = 512;
const MAX_REDIRECT_URIS = 8;
const MAX_REDIRECT_URI_BYTES = 512;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_SCOPE_LENGTH = 500;
const DOT_SEGMENT_PATTERN = /(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|\?|#|$)/i;

const DEFAULTS = {
	maxDocumentBytes: 8_192,
	fetchTimeoutMs: 5_000,
	defaultCacheTtlMs: 300_000,
	minCacheTtlMs: 60_000,
	maxCacheTtlMs: 900_000,
	maxCacheEntries: 256,
	maxConcurrentFetches: 8,
	maxQueuedFetches: 64,
	failureThreshold: 3,
	failureWindowMs: 60_000,
	cooldownMs: 30_000,
} as const;

/** Quick shape test: URL-shaped client_ids enter CIMD resolution, others do not. */
export function isClientIdMetadataUrl(clientId: string): boolean {
	if (!clientId.startsWith("https://")) return false;
	try {
		return new URL(clientId).pathname.length > 1;
	} catch {
		return false;
	}
}

/**
 * Resolves and validates Client ID Metadata Documents (the 2026-07-28
 * replacement for Dynamic Client Registration). Successful documents are
 * cached (LRU, TTL-clamped, `no-store` honored); failures are never cached —
 * per-host throttling is a circuit breaker, not a cached error response.
 */
export function createMcpClientIdMetadataResolver(
	options?: McpClientIdMetadataResolverOptions,
): McpClientIdMetadataResolver {
	const config = { ...DEFAULTS, ...definedEntries(options) };
	const fetcher = options?.fetcher ?? createNodeDocumentFetcher();
	const now = options?.now ?? Date.now;
	const cache = new Map<string, McpClientIdMetadata>();
	const inFlight = new Map<string, Promise<McpClientIdMetadata>>();
	const breaker = new HostCircuitBreaker(
		config.failureThreshold,
		config.failureWindowMs,
		config.cooldownMs,
		now,
	);
	const semaphore = new Semaphore(config.maxConcurrentFetches, config.maxQueuedFetches);

	const resolveFresh = async (
		clientId: string,
		url: URL,
		signal: AbortSignal | undefined,
	): Promise<McpClientIdMetadata> => {
		breaker.assertClosed(url.hostname);
		let release: () => void;
		try {
			release = await semaphore.acquire();
		} catch (cause) {
			// Queue overflow — reject as retryable without touching the network.
			breaker.recordFailure(url.hostname);
			throw new McpClientIdMetadataError(
				"throttled",
				"Client ID metadata resolution is temporarily overloaded.",
				{ cause },
			);
		}
		try {
			const document = await fetcher.fetchDocument(url, {
				maxBytes: config.maxDocumentBytes,
				totalTimeoutMs: config.fetchTimeoutMs,
				accept: "application/json",
				...(signal === undefined ? {} : { signal }),
			});
			if (document.status >= 300 && document.status < 400) {
				throw new McpClientIdMetadataError(
					"redirect-not-allowed",
					"Client ID metadata documents must not redirect.",
				);
			}
			if (document.status !== 200) {
				throw new McpClientIdMetadataError("http-status", "Client ID metadata fetch failed.", {
					oauthError: document.status >= 500 ? "temporarily_unavailable" : "invalid_client",
				});
			}
			if (!isJsonContentTypeEssence(document.contentType)) {
				throw new McpClientIdMetadataError(
					"content-type",
					"Client ID metadata documents must be served as application/json.",
				);
			}
			const resolvedAt = now();
			const ttlMs = cacheTtlMs(document.cacheControl, config);
			const metadata = validateClientIdMetadataDocument(clientId, document.body, {
				resolvedAt,
				expiresAt: resolvedAt + (ttlMs ?? 0),
			});
			if (ttlMs !== undefined) {
				cache.delete(clientId);
				cache.set(clientId, metadata);
				while (cache.size > config.maxCacheEntries) {
					const oldest = cache.keys().next().value;
					if (oldest === undefined) break;
					cache.delete(oldest);
				}
			}
			breaker.recordSuccess(url.hostname);
			return metadata;
		} catch (cause) {
			breaker.recordFailure(url.hostname);
			throw toMetadataError(cause);
		} finally {
			release();
		}
	};

	return {
		resolve: (clientId, resolveOptions) => {
			const url = admitClientIdUrl(clientId, config, options?.allowedHosts);
			const cached = cache.get(clientId);
			if (cached !== undefined && cached.expiresAt > now()) {
				// LRU refresh on hit.
				cache.delete(clientId);
				cache.set(clientId, cached);
				return Promise.resolve(cached);
			}
			if (cached !== undefined) cache.delete(clientId);
			const pending = inFlight.get(clientId);
			if (pending !== undefined) return pending;
			const task = resolveFresh(clientId, url, resolveOptions?.signal).finally(() => {
				inFlight.delete(clientId);
			});
			inFlight.set(clientId, task);
			return task;
		},
	};
}

function rejectMalformedClientId(message: string): never {
	throw new McpClientIdMetadataError("malformed-client-id", message);
}

function rejectInvalidDocument(message: string): never {
	throw new McpClientIdMetadataError("invalid-document", message);
}

/** Applies the CIMD §3 admission rules; no I/O happens for rejected URLs. */
export function admitClientIdUrl(
	clientId: string,
	config: { readonly allowQueryInClientId?: boolean; readonly allowNonDefaultPort?: boolean },
	allowedHosts?: readonly string[],
): URL {
	const reject = rejectMalformedClientId;
	if (typeof clientId !== "string" || clientId.length === 0) {
		reject("client_id must be a non-empty string.");
	}
	if (Buffer.byteLength(clientId) > MAX_CLIENT_ID_BYTES) {
		reject("client_id exceeds the URL length limit.");
	}
	// Judge dot segments on the raw string: URL parsing silently resolves them.
	if (DOT_SEGMENT_PATTERN.test(clientId)) {
		reject("client_id must not contain dot path segments.");
	}
	if (clientId.includes("#")) reject("client_id must not contain a fragment.");
	let url: URL;
	try {
		url = new URL(clientId);
	} catch {
		return reject("client_id must be an absolute URL.");
	}
	if (url.protocol !== "https:") reject("client_id must use the https scheme.");
	if (url.pathname.length <= 1) reject("client_id must include a path component.");
	// Restrict to the default https port unless explicitly opted in, so a client_id
	// cannot turn resolution into an arbitrary-port outbound probe.
	if (url.port !== "" && url.port !== "443" && config.allowNonDefaultPort !== true) {
		reject("client_id must use the default https port.");
	}
	if (url.username !== "" || url.password !== "") reject("client_id must not contain userinfo.");
	if (url.search !== "" && config.allowQueryInClientId !== true) {
		reject("client_id must not contain a query.");
	}
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	if (isIP(host) !== 0 && isBlockedDocumentAddress(host)) {
		throw new McpClientIdMetadataError(
			"blocked-address",
			"client_id host is in a blocked address range.",
		);
	}
	if (allowedHosts !== undefined && !hostAllowed(url.hostname, allowedHosts)) {
		throw new McpClientIdMetadataError(
			"host-not-allowed",
			"client_id host is not in the configured allowlist.",
		);
	}
	return url;
}

/** Validates a fetched document against the CIMD §4.1 rules. */
export function validateClientIdMetadataDocument(
	clientId: string,
	body: string,
	stamps: { readonly resolvedAt: number; readonly expiresAt: number },
): McpClientIdMetadata {
	const reject = rejectInvalidDocument;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return reject("Client ID metadata document is not valid JSON.");
	}
	if (!isRecord(parsed)) {
		return reject("Client ID metadata document must be a JSON object.");
	}
	const document = parsed;
	if (document["client_id"] !== clientId) {
		reject("Client ID metadata document must reference its own URL as client_id.");
	}
	for (const forbidden of ["client_secret", "client_secret_expires_at"]) {
		if (forbidden in document) {
			reject("Client ID metadata documents must not contain client secrets.");
		}
	}
	const clientName = document["client_name"];
	if (typeof clientName !== "string" || clientName.trim().length === 0) {
		return reject("Client ID metadata documents must declare a client_name.");
	}
	if (clientName.trim().length > MAX_CLIENT_NAME_LENGTH) {
		reject("client_name exceeds the length limit.");
	}
	const rawAuthMethod = document["token_endpoint_auth_method"] ?? "none";
	const authMethod =
		rawAuthMethod === "none" || rawAuthMethod === "private_key_jwt"
			? rawAuthMethod
			: reject("Client ID metadata clients must use the none or private_key_jwt auth method.");
	const grantTypes = document["grant_types"];
	if (grantTypes !== undefined) {
		if (
			!Array.isArray(grantTypes) ||
			grantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")
		) {
			reject("Client ID metadata grant_types may only be authorization_code and refresh_token.");
		}
	}
	const responseTypes = document["response_types"];
	if (responseTypes !== undefined) {
		if (
			!Array.isArray(responseTypes) ||
			responseTypes.length !== 1 ||
			responseTypes[0] !== "code"
		) {
			reject('Client ID metadata response_types must be exactly ["code"].');
		}
	}
	const redirectUris: unknown = document["redirect_uris"];
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		redirectUris.length > MAX_REDIRECT_URIS
	) {
		return reject(
			`Client ID metadata must declare 1 to ${String(MAX_REDIRECT_URIS)} redirect_uris.`,
		);
	}
	let loopbackOnly = true;
	const validatedRedirects: string[] = [];
	for (const entry of redirectUris as readonly unknown[]) {
		if (typeof entry !== "string" || Buffer.byteLength(entry) > MAX_REDIRECT_URI_BYTES) {
			return reject("Client ID metadata redirect_uris entries must be bounded strings.");
		}
		const redirect = parseRedirectUri(entry);
		if (redirect === undefined) {
			return reject("Client ID metadata redirect_uris must be https or loopback URLs.");
		}
		if (!redirect.loopback) loopbackOnly = false;
		validatedRedirects.push(entry);
	}
	const scope = document["scope"];
	if (scope !== undefined && (typeof scope !== "string" || scope.length > MAX_SCOPE_LENGTH)) {
		reject("Client ID metadata scope must be a bounded space-delimited string.");
	}
	const jwksUri = document["jwks_uri"];
	if (jwksUri !== undefined) {
		if (typeof jwksUri !== "string" || !isClientIdMetadataUrl(jwksUri)) {
			return reject("Client ID metadata jwks_uri must be an https URL with a path.");
		}
		if (DOT_SEGMENT_PATTERN.test(jwksUri)) {
			reject("Client ID metadata jwks_uri must not contain dot path segments.");
		}
	}
	if (authMethod === "private_key_jwt" && jwksUri === undefined) {
		reject("private_key_jwt clients must declare a jwks_uri.");
	}
	const clientUri = document["client_uri"];
	const logoUri = document["logo_uri"];
	return Object.freeze({
		clientId,
		clientName: clientName.trim(),
		redirectUris: Object.freeze(validatedRedirects),
		tokenEndpointAuthMethod: authMethod,
		loopbackOnly,
		resolvedAt: stamps.resolvedAt,
		expiresAt: stamps.expiresAt,
		...(typeof scope === "string" ? { scope } : {}),
		...(typeof jwksUri === "string" ? { jwksUri } : {}),
		...(typeof clientUri === "string" ? { clientUri } : {}),
		...(typeof logoUri === "string" ? { logoUri } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact string match against the registered set; loopback comparison is the caller's policy. */
export function parseRedirectUri(
	value: string,
): { readonly url: URL; readonly loopback: boolean } | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.hash !== "" || url.username !== "" || url.password !== "") return undefined;
	if (url.protocol === "https:") return { url, loopback: false };
	if (url.protocol !== "http:") return undefined;
	const loopback =
		url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
	return loopback ? { url, loopback: true } : undefined;
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
	const host = hostname.toLowerCase();
	return allowedHosts.some((entry) => {
		const allowed = entry.toLowerCase();
		if (allowed.startsWith(".")) return host.endsWith(allowed) && host.length > allowed.length;
		return host === allowed;
	});
}

function cacheTtlMs(
	cacheControl: string | undefined,
	config: {
		readonly defaultCacheTtlMs: number;
		readonly minCacheTtlMs: number;
		readonly maxCacheTtlMs: number;
	},
): number | undefined {
	const directives = (cacheControl ?? "")
		.split(",")
		.map((directive) => directive.trim().toLowerCase());
	if (directives.includes("no-store") || directives.includes("no-cache")) return undefined;
	const maxAge = directives
		.map((directive) => /^max-age=(\d{1,10})$/.exec(directive))
		.find((match): match is RegExpExecArray => match !== null);
	const requested = maxAge === undefined ? config.defaultCacheTtlMs : Number(maxAge[1]) * 1_000;
	if (requested === 0) return undefined;
	return Math.min(Math.max(requested, config.minCacheTtlMs), config.maxCacheTtlMs);
}

function isJsonContentTypeEssence(contentType: string | undefined): boolean {
	if (contentType === undefined) return false;
	const essence = contentType.split(";")[0]?.trim().toLowerCase();
	return essence === "application/json";
}

function toMetadataError(cause: unknown): McpClientIdMetadataError {
	if (cause instanceof McpClientIdMetadataError) return cause;
	if (cause instanceof McpDocumentFetchError) {
		switch (cause.reason) {
			case "blocked-address":
			case "insecure-url":
				return new McpClientIdMetadataError(
					"blocked-address",
					"client_id host is in a blocked address range.",
					{ cause },
				);
			case "host-not-allowed":
				return new McpClientIdMetadataError(
					"host-not-allowed",
					"client_id host is not in the configured allowlist.",
					{ cause },
				);
			case "too-large":
				return new McpClientIdMetadataError(
					"too-large",
					"Client ID metadata document exceeds the size limit.",
					{ cause },
				);
			case "timeout":
				return new McpClientIdMetadataError("timeout", "Client ID metadata fetch timed out.", {
					cause,
				});
			case "network":
				return new McpClientIdMetadataError("http-status", "Client ID metadata fetch failed.", {
					cause,
				});
		}
	}
	return new McpClientIdMetadataError("invalid-document", "Client ID metadata rejected.", {
		cause,
		oauthError: "server_error",
	});
}

function definedEntries<T extends object>(value: T | undefined): Partial<T> {
	if (value === undefined) return {};
	const result: Partial<T> = {};
	for (const [key, entry] of Object.entries(value)) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
	}
	return result;
}

class HostCircuitBreaker {
	readonly #failures = new Map<string, { timestamps: number[]; cooldownUntil: number }>();

	constructor(
		private readonly threshold: number,
		private readonly windowMs: number,
		private readonly cooldownMs: number,
		private readonly now: () => number,
	) {}

	assertClosed(host: string): void {
		const record = this.#failures.get(host);
		if (record !== undefined && record.cooldownUntil > this.now()) {
			throw new McpClientIdMetadataError(
				"throttled",
				"Client ID metadata fetches for this host are temporarily throttled.",
			);
		}
	}

	recordFailure(host: string): void {
		const at = this.now();
		const record = this.#failures.get(host) ?? { timestamps: [], cooldownUntil: 0 };
		record.timestamps = record.timestamps.filter((stamp) => at - stamp < this.windowMs);
		record.timestamps.push(at);
		if (record.timestamps.length >= this.threshold) {
			record.cooldownUntil = at + this.cooldownMs;
			record.timestamps = [];
		}
		this.#failures.set(host, record);
		// Bound the breaker map itself against host flooding.
		while (this.#failures.size > 1_024) {
			const oldest = this.#failures.keys().next().value;
			if (oldest === undefined) break;
			this.#failures.delete(oldest);
		}
	}

	recordSuccess(host: string): void {
		this.#failures.delete(host);
	}
}

class SemaphoreOverflowError extends Error {}

class Semaphore {
	#available: number;
	readonly #waiters: (() => void)[] = [];

	constructor(
		capacity: number,
		private readonly maxQueued: number,
	) {
		this.#available = capacity;
	}

	async acquire(): Promise<() => void> {
		if (this.#available > 0) {
			this.#available -= 1;
		} else {
			// Shed load rather than queue unboundedly: an unauthenticated caller
			// must not be able to grow the wait list without limit.
			if (this.#waiters.length >= this.maxQueued) {
				throw new SemaphoreOverflowError("Outbound fetch queue is full.");
			}
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next !== undefined) next();
			else this.#available += 1;
		};
	}
}
