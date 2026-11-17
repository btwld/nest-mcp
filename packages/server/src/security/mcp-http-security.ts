import {
	hostHeaderValidationResponse,
	localhostAllowedOrigins,
	originValidationResponse,
	validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import { McpServerRuntimeError } from "../mcp-server.errors.ts";
import type { McpFetchHandler } from "../auth/mcp-resource-server.ts";

export const MCP_DEFAULT_MAX_BODY_BYTES = 1_048_576;

export const MCP_CORS_METHODS: readonly string[] = Object.freeze([
	"GET",
	"POST",
	"DELETE",
	"OPTIONS",
]);

/**
 * Request headers the 2026-07-28 revision requires browser clients to send.
 * `Mcp-Method`/`Mcp-Name` make every modern MCP POST CORS-preflighted.
 */
export const MCP_CORS_ALLOWED_HEADERS: readonly string[] = Object.freeze([
	"authorization",
	"content-type",
	"accept",
	"mcp-protocol-version",
	"mcp-method",
	"mcp-name",
	"mcp-session-id",
	"last-event-id",
]);

export const MCP_CORS_EXPOSED_HEADERS: readonly string[] = Object.freeze([
	"mcp-session-id",
	"www-authenticate",
]);

const DEFAULT_CORS_MAX_AGE_SECONDS = 600;
const PREFLIGHT_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

export interface McpCorsOptions {
	/**
	 * Allows cookies/credentialed requests. Cookie-authenticated MCP endpoints
	 * are CSRF-able; leave off unless required. When enabled, `allowedOrigins`
	 * is mandatory and the grant matches the full origin exactly — never a bare
	 * hostname — so a compromised sibling scheme or port cannot inherit it.
	 */
	readonly credentials?: boolean;
	/**
	 * Full browser origins (e.g. `https://app.example.com`) permitted to make
	 * credentialed requests. Required when `credentials` is true; ignored
	 * otherwise (non-credentialed CORS reflects any origin the allowlist admits).
	 */
	readonly allowedOrigins?: readonly string[];
	readonly maxAgeSeconds?: number;
	readonly additionalAllowedHeaders?: readonly string[];
	readonly additionalExposedHeaders?: readonly string[];
}

export interface McpHttpSecurityOptions {
	/** Host-header allowlist (hostnames only). Defaults to off: proxies rewrite `Host`, and the Origin rung already blocks DNS rebinding. */
	readonly allowedHostnames?: readonly string[] | false;
	/**
	 * Origin-header allowlist (hostnames only). Defaults to localhost-class
	 * origins, so routable browser origins are denied until configured.
	 * Requests without an `Origin` header always pass. `false` disables the check.
	 */
	readonly allowedOriginHostnames?: readonly string[] | false;
	/** CORS handling for allowed origins. Defaults to on whenever origin validation is on. */
	readonly cors?: McpCorsOptions | boolean;
	/** Request-body byte cap. Defaults to 1 MiB; `false` disables the cap. */
	readonly maxBodyBytes?: number | false;
}

interface ResolvedCorsPolicy {
	readonly credentials: boolean;
	readonly maxAgeSeconds: number;
	readonly allowedHeaders: string;
	readonly allowedHeaderSet: ReadonlySet<string>;
	readonly exposedHeaders: string;
	readonly methods: string;
	/** Exact-origin allowlist enforced only in credentialed mode. */
	readonly allowedOrigins: ReadonlySet<string> | undefined;
}

/** Reports a pre-dispatch rejection (status ≥ 400) to an outer observer. */
export interface McpHardenHooks {
	readonly onRejected?: (status: number) => void;
}

export interface McpHttpSecurityPolicy {
	readonly resolved: true;
	readonly allowedHostnames: readonly string[] | undefined;
	readonly allowedOriginHostnames: readonly string[] | undefined;
	readonly cors: ResolvedCorsPolicy | undefined;
	readonly maxBodyBytes: number | undefined;
}

/** Resolves and validates the declarative options into a frozen policy. */
export function resolveMcpHttpSecurity(options?: McpHttpSecurityOptions): McpHttpSecurityPolicy {
	if (options !== undefined && (typeof options !== "object" || options === null)) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity must be an object when present.",
		);
	}
	const allowedHostnames =
		options?.allowedHostnames === undefined || options.allowedHostnames === false
			? undefined
			: normalizeHostnameList(options.allowedHostnames, "httpSecurity.allowedHostnames");
	const allowedOriginHostnames =
		options?.allowedOriginHostnames === false
			? undefined
			: options?.allowedOriginHostnames === undefined
				? Object.freeze(localhostAllowedOrigins().map((value) => value.toLowerCase()))
				: normalizeHostnameList(
						options.allowedOriginHostnames,
						"httpSecurity.allowedOriginHostnames",
					);
	const cors = resolveCors(options?.cors, allowedOriginHostnames !== undefined);
	const maxBodyBytes =
		options?.maxBodyBytes === false
			? undefined
			: (options?.maxBodyBytes ?? MCP_DEFAULT_MAX_BODY_BYTES);
	if (maxBodyBytes !== undefined && (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0)) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity.maxBodyBytes must be a positive integer or false.",
		);
	}
	return Object.freeze({
		resolved: true,
		allowedHostnames,
		allowedOriginHostnames,
		cors,
		maxBodyBytes,
	});
}

export function isMcpHttpSecurityPolicy(value: unknown): value is McpHttpSecurityPolicy {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "resolved") === true &&
		Object.isFrozen(value)
	);
}

/**
 * The pre-dispatch gate: Host validation, then Origin validation, then CORS
 * preflight. Returns a short-circuit `Response`, or `undefined` to proceed.
 * A preflight from a rejected origin gets the 403 with no CORS headers.
 */
export function mcpHttpSecurityRejection(
	request: Request,
	policy: McpHttpSecurityPolicy,
): Response | undefined {
	if (policy.allowedHostnames !== undefined) {
		const rejection = hostHeaderValidationResponse(request, [...policy.allowedHostnames]);
		if (rejection !== undefined) return rejection;
	}
	if (policy.allowedOriginHostnames !== undefined) {
		const rejection = originValidationResponse(request, [...policy.allowedOriginHostnames]);
		if (rejection !== undefined) return rejection;
	}
	if (policy.cors !== undefined && isPreflight(request)) {
		const origin = corsAllowedOrigin(request, policy);
		// A preflight from a disallowed origin gets 403 with no CORS headers.
		if (origin === undefined) {
			return new Response(null, { status: 403 });
		}
		return preflightResponse(request, policy.cors, origin);
	}
	return undefined;
}

/**
 * Decorates a response with CORS headers when the request carries an allowed
 * Origin. Rebuilds the response without buffering so streamed SSE bodies keep
 * streaming; a response that already carries an ACAO header is left untouched.
 */
export function applyMcpCorsHeaders(
	request: Request,
	response: Response,
	policy: McpHttpSecurityPolicy,
): Response {
	if (policy.cors === undefined) return response;
	const origin = corsAllowedOrigin(request, policy);
	if (origin === undefined) return response;
	if (response.headers.get("access-control-allow-origin") !== null) return response;
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-expose-headers", policy.cors.exposedHeaders);
	if (policy.cors.credentials) headers.set("access-control-allow-credentials", "true");
	appendVary(headers, "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Enforces the body cap. Returns the request (re-wrapped when the stream had
 * to be counted) or a `413` response. Already-limited requests pass through
 * untouched so double wrapping never buffers twice.
 */
export async function limitMcpRequestBody(
	request: Request,
	policy: McpHttpSecurityPolicy,
): Promise<Request | Response> {
	const maxBodyBytes = policy.maxBodyBytes;
	if (maxBodyBytes === undefined || request.body === null) {
		return request;
	}
	const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
		return bodyTooLargeResponse(maxBodyBytes);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = request.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBodyBytes) {
				await reader.cancel();
				return bodyTooLargeResponse(maxBodyBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	// The rebuilt request carries an in-memory body, so a stricter inner layer
	// can re-read and re-cap it without exhausting a one-shot stream.
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: concatChunks(chunks, total),
		signal: request.signal,
	});
}

/**
 * Wraps any fetch-shaped handler with the full gate → cap → CORS pipeline.
 * The forwarded request is marked as secured so the runtime's *implicit*
 * default gate defers to this explicit layer (an outer override can loosen as
 * well as tighten). Explicit hardened layers still run — the mark suppresses
 * only the runtime's built-in default, never another constructed facade — so
 * composed policies intersect.
 */
export function hardenMcpFetch(
	handler: {
		fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
	},
	policy: McpHttpSecurityPolicy,
	hooks?: McpHardenHooks,
): { fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> } {
	return {
		fetch: async (request, options) => {
			const rejection = mcpHttpSecurityRejection(request, policy);
			if (rejection !== undefined) {
				reportRejection(rejection.status, hooks);
				return rejection;
			}
			const limited = await limitMcpRequestBody(request, policy);
			if (limited instanceof Response) {
				reportRejection(limited.status, hooks);
				return applyMcpCorsHeaders(request, limited, policy);
			}
			markMcpRequestSecured(limited);
			const response = await handler.fetch(limited, options);
			return applyMcpCorsHeaders(request, response, policy);
		},
	};
}

function reportRejection(status: number, hooks: McpHardenHooks | undefined): void {
	if (status >= 400 && hooks?.onRejected !== undefined) {
		try {
			hooks.onRejected(status);
		} catch {
			// Observability must never change the response.
		}
	}
}

/** Marks a request as already gated by the outermost explicit security layer. */
export function markMcpRequestSecured(request: Request): void {
	securedRequests.add(request);
}

export function isMcpRequestSecured(request: Request): boolean {
	return securedRequests.has(request);
}

/** Hardened facade preserving the full `McpFetchHandler` face, like `McpValidatedServer`. */
export class McpHardenedServer implements McpFetchHandler {
	readonly notify: McpFetchHandler["notify"];
	readonly bus: McpFetchHandler["bus"];

	readonly #handler: McpFetchHandler;
	readonly #policy: McpHttpSecurityPolicy;
	readonly #hardened: ReturnType<typeof hardenMcpFetch>;

	constructor(
		handler: McpFetchHandler,
		options?: McpHttpSecurityOptions | McpHttpSecurityPolicy,
		hooks?: McpHardenHooks,
	) {
		this.#handler = handler;
		this.#policy = isMcpHttpSecurityPolicy(options) ? options : resolveMcpHttpSecurity(options);
		this.#hardened = hardenMcpFetch(handler, this.#policy, hooks);
		this.notify = handler.notify;
		this.bus = handler.bus;
	}

	get policy(): McpHttpSecurityPolicy {
		return this.#policy;
	}

	fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		return this.#hardened.fetch(request, options);
	}

	close(): Promise<void> {
		return this.#handler.close();
	}
}

const securedRequests = new WeakSet<Request>();

function resolveCors(
	cors: McpCorsOptions | boolean | undefined,
	originValidationEnabled: boolean,
): ResolvedCorsPolicy | undefined {
	if (cors === false) return undefined;
	if (cors === undefined && !originValidationEnabled) return undefined;
	const options = cors === true || cors === undefined ? {} : cors;
	if (typeof options !== "object" || options === null) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity.cors must be a boolean or an options object.",
		);
	}
	const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_CORS_MAX_AGE_SECONDS;
	if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity.cors.maxAgeSeconds must be a non-negative integer.",
		);
	}
	const credentials = options.credentials === true;
	const allowedOrigins = resolveAllowedOrigins(options.allowedOrigins);
	if (credentials && allowedOrigins === undefined) {
		// Credentialed CORS must never reflect an arbitrary Origin: an ACAO+ACAC
		// grant on hostname-only matching would leak to any scheme/port sibling.
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity.cors.credentials requires an explicit cors.allowedOrigins full-origin allowlist.",
		);
	}
	const allowedHeaderSet = mergeHeaderSet(
		MCP_CORS_ALLOWED_HEADERS,
		options.additionalAllowedHeaders,
	);
	return Object.freeze({
		credentials,
		maxAgeSeconds,
		allowedHeaders: [...allowedHeaderSet].join(", "),
		allowedHeaderSet,
		exposedHeaders: [
			...mergeHeaderSet(MCP_CORS_EXPOSED_HEADERS, options.additionalExposedHeaders),
		].join(", "),
		methods: MCP_CORS_METHODS.join(", "),
		allowedOrigins,
	});
}

function resolveAllowedOrigins(
	values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
	if (values === undefined) return undefined;
	if (!Array.isArray(values)) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			"httpSecurity.cors.allowedOrigins must be an array of full origins.",
		);
	}
	const origins = new Set<string>();
	for (const value of values) {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			throw new McpServerRuntimeError(
				"INVALID_DEFINITION",
				`httpSecurity.cors.allowedOrigins entry "${String(value)}" must be a full origin.`,
			);
		}
		if (parsed.origin === "null") {
			throw new McpServerRuntimeError(
				"INVALID_DEFINITION",
				"httpSecurity.cors.allowedOrigins entries must be non-opaque origins.",
			);
		}
		origins.add(parsed.origin);
	}
	return origins;
}

function mergeHeaderSet(
	base: readonly string[],
	additional?: readonly string[],
): ReadonlySet<string> {
	const merged = new Set(base.map((header) => header.toLowerCase()));
	for (const header of additional ?? []) {
		if (typeof header !== "string" || header.trim().length === 0) {
			throw new McpServerRuntimeError(
				"INVALID_DEFINITION",
				"httpSecurity.cors header names must be non-empty strings.",
			);
		}
		merged.add(header.trim().toLowerCase());
	}
	return merged;
}

function normalizeHostnameList(values: readonly string[], field: string): readonly string[] {
	if (!Array.isArray(values)) {
		throw new McpServerRuntimeError(
			"INVALID_DEFINITION",
			`${field} must be an array of hostnames or false.`,
		);
	}
	// An empty list is a valid deny-all posture for routable binds.
	return Object.freeze(
		values.map((value, index) => {
			const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
			if (normalized.length === 0) {
				throw new McpServerRuntimeError(
					"INVALID_DEFINITION",
					`${field}[${String(index)}] must be a non-empty string.`,
				);
			}
			if (normalized.includes("://") || normalized.includes("/")) {
				throw new McpServerRuntimeError(
					"INVALID_DEFINITION",
					`${field}[${String(index)}] must be a hostname without a scheme or path.`,
				);
			}
			return normalized;
		}),
	);
}

function isPreflight(request: Request): boolean {
	return (
		request.method === "OPTIONS" &&
		request.headers.get("origin") !== null &&
		request.headers.get("access-control-request-method") !== null
	);
}

function preflightResponse(request: Request, cors: ResolvedCorsPolicy, origin: string): Response {
	const headers = new Headers({
		"access-control-allow-origin": origin,
		"access-control-allow-methods": cors.methods,
		"access-control-allow-headers": allowedRequestHeaders(request, cors),
		"access-control-max-age": String(cors.maxAgeSeconds),
		vary: PREFLIGHT_VARY,
	});
	if (cors.credentials) headers.set("access-control-allow-credentials", "true");
	// 200 rather than 204: Express strips headers on 204/304 inside send(), which
	// throws when a framework reply path runs after the adapter already responded.
	return new Response(null, { status: 200, headers });
}

/** Intersects the browser's requested headers with the allowlist; no `*`, which excludes Authorization. */
function allowedRequestHeaders(request: Request, cors: ResolvedCorsPolicy): string {
	const requested = request.headers.get("access-control-request-headers");
	if (requested === null) return cors.allowedHeaders;
	const permitted = requested
		.split(",")
		.map((header) => header.trim().toLowerCase())
		.filter((header) => header.length > 0 && cors.allowedHeaderSet.has(header));
	return permitted.length === 0 ? cors.allowedHeaders : permitted.join(", ");
}

/**
 * The origin to echo in `Access-Control-Allow-Origin`, or `undefined` to omit.
 * Credentialed mode requires an exact full-origin match; non-credentialed mode
 * reflects any origin the hostname allowlist admits.
 */
export function corsAllowedOrigin(
	request: Request,
	policy: McpHttpSecurityPolicy,
): string | undefined {
	const cors = policy.cors;
	if (cors === undefined) return undefined;
	const origin = request.headers.get("origin");
	if (origin === null || origin.length === 0) return undefined;
	if (cors.credentials) {
		return cors.allowedOrigins?.has(origin) === true ? origin : undefined;
	}
	if (policy.allowedOriginHostnames === undefined) return origin;
	return validateOriginHeader(origin, [...policy.allowedOriginHostnames]).ok ? origin : undefined;
}

function appendVary(headers: Headers, value: string): void {
	const existing = headers.get("vary");
	if (existing === null) {
		headers.set("vary", value);
		return;
	}
	const present = existing
		.split(",")
		.some((entry) => entry.trim().toLowerCase() === value.toLowerCase());
	if (!present) headers.set("vary", `${existing}, ${value}`);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function bodyTooLargeResponse(maxBodyBytes: number): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32600,
				message: `Request body exceeds the ${String(maxBodyBytes)}-byte limit.`,
			},
			id: null,
		}),
		{ status: 413, headers: { "content-type": "application/json" } },
	);
}
