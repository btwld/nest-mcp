import type {
	Agent as HttpAgent,
	ClientRequest,
	IncomingHttpHeaders,
	IncomingMessage,
} from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
	createGuardedAgents,
	createGuardedHostPolicy,
	defaultGuardedLookup,
	guardedLookup,
	McpDocumentFetchError,
	normalizeGuardedHost,
	normalizeGuardedRequest,
} from "./ssrf-fetch.ts";
import type {
	McpDocumentLookup,
	McpGuardedHostPolicyOptions,
	McpGuardedLookupHook,
	McpGuardedTarget,
	McpResolvedAddress,
} from "./ssrf-fetch.ts";

/**
 * A complete `fetch` face — structurally the SDK's `FetchLike`, so it drops
 * straight into `McpHttpClientTransportDefinition.fetch` with no cast.
 */
export type McpStreamingFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface McpStreamingSsrfGuardedFetchOptions extends McpGuardedHostPolicyOptions {
	/** Injectable resolver for tests; defaults to `dns.lookup` with `all: true`. */
	readonly lookup?: McpDocumentLookup;
	/** Milliseconds allowed between response bytes while the body is being read. */
	readonly idleTimeoutMs?: number;
	/** Running total for non-SSE responses. Ignored for `text/event-stream`. */
	readonly maxResponseBytes?: number;
	/** Per-event cap for `text/event-stream`; the counter resets on a blank line. */
	readonly maxSseEventBytes?: number;
}

/** Total-body fence for non-SSE responses (4 MiB). */
export const MCP_STREAM_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
/** Per-event fence for `text/event-stream` responses (1 MiB). */
export const MCP_STREAM_MAX_SSE_EVENT_BYTES = 1_024 * 1_024;
/** Bytes must keep arriving this often once the body is being read (5 minutes). */
export const MCP_STREAM_IDLE_TIMEOUT_MS = 300_000;

const MAX_DNS_ANSWERS = 16;
const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;
// RFC 9112 reason-phrase: HTAB / SP / VCHAR / obs-text. Anything outside that
// makes the `Response` constructor throw, so it degrades to an empty string.
const REASON_PHRASE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

interface StreamLimits {
	readonly idleTimeoutMs: number;
	readonly maxResponseBytes: number;
	readonly maxSseEventBytes: number;
}

/**
 * A transport-grade SSRF-guarded `fetch`: the same connect-time DNS pinning,
 * blocked-range predicate, SNI pinning, and no-redirect rule as
 * `createSsrfGuardedFetch`, but the response body is handed back as a live
 * `ReadableStream` instead of a buffer. That is what a long-lived
 * `text/event-stream` MCP session needs, and the buffering fetch structurally
 * cannot serve.
 *
 * Fences: a running total for ordinary responses, a per-event cap for SSE (no
 * total cap, since a healthy session streams indefinitely), and an idle window
 * between bytes. A violation errors the stream and destroys the connection.
 */
export function createStreamingSsrfGuardedFetch(
	options?: McpStreamingSsrfGuardedFetchOptions,
): McpStreamingFetchLike {
	const resolve = options?.lookup ?? defaultGuardedLookup;
	const policy = createGuardedHostPolicy(options);
	const limits = resolveStreamLimits(options);
	// Keep-alive is what makes this transport-grade: the SSE GET and the POSTs
	// that ride alongside it must not renegotiate TLS per message.
	const agents = createGuardedAgents({
		keepAlive: true,
		maxSockets: 16,
		timeout: limits.idleTimeoutMs,
	});

	return async (input, init) => {
		const url = toRequestUrl(input);
		const target = policy.admit(url);
		return await sendGuardedStreamingRequest({
			url,
			target,
			agent: agents.for(target.secure),
			lookup: guardedLookup(resolve, policy.admitsAddress(target)),
			staged: await stageStreamingRequest(url.host, init),
			method: (init?.method ?? "GET").toUpperCase(),
			signal: init?.signal ?? undefined,
			limits,
		});
	};
}

/** An endpoint that passed admission; the pinned answers are held privately. */
export interface McpAdmittedHttpEndpoint {
	readonly url: string;
	readonly origin: string;
	readonly hostname: string;
	readonly secure: boolean;
}

export interface McpEndpointAdmissionPolicy extends McpGuardedHostPolicyOptions {
	/** Injectable resolver for tests; defaults to `dns.lookup` with `all: true`. */
	readonly lookup?: McpDocumentLookup;
	/** Permits query strings at admission and throughout the resulting lease; off by default. */
	readonly allowQuery?: boolean;
	readonly signal?: AbortSignal;
}

export interface McpGuardedFetchLease {
	readonly fetch: McpStreamingFetchLike;
	/** Destroys the pooled sockets. Idempotent. */
	close(): Promise<void>;
}

export interface McpGuardedFetchLeaseOptions {
	readonly idleTimeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly maxSseEventBytes?: number;
}

interface AdmittedEndpointState {
	readonly addresses: readonly McpResolvedAddress[];
	readonly allowQuery: boolean;
	readonly target: McpGuardedTarget;
}

// Admission state lives here, not on the returned record: a host cannot forge
// an admitted endpoint by handing `openGuardedFetch` a look-alike object.
const admittedEndpoints = new WeakMap<McpAdmittedHttpEndpoint, AdmittedEndpointState>();

/**
 * Resolves and validates an endpoint once, before any credential is touched.
 * Splitting admission from the connection lets a host reject an endpoint
 * without ever decrypting the token it would have sent.
 */
export async function admitMcpHttpEndpoint(
	url: string | URL,
	policy?: McpEndpointAdmissionPolicy,
): Promise<McpAdmittedHttpEndpoint> {
	const endpoint = toRequestUrl(url);
	const allowQuery = policy?.allowQuery === true;
	assertGuardedUrlShape(endpoint, allowQuery);
	const hostPolicy = createGuardedHostPolicy(policy);
	const target = hostPolicy.admit(endpoint);
	const addresses = await resolveAdmittedAddresses(
		policy?.lookup ?? defaultGuardedLookup,
		target,
		hostPolicy.admitsAddress(target),
		policy?.signal,
	);
	const admitted: McpAdmittedHttpEndpoint = Object.freeze({
		url: endpoint.href,
		origin: endpoint.origin,
		hostname: target.host,
		secure: target.secure,
	});
	admittedEndpoints.set(admitted, Object.freeze({ addresses, allowQuery, target }));
	return admitted;
}

/**
 * Opens a guarded fetch bound to one admitted endpoint. Sockets resolve only
 * through the addresses captured at admission, and every request must stay on
 * the admitted origin.
 */
export function openGuardedFetch(
	admitted: McpAdmittedHttpEndpoint,
	options?: McpGuardedFetchLeaseOptions,
): McpGuardedFetchLease {
	const state = admittedEndpoints.get(admitted);
	if (state === undefined) {
		throw new McpDocumentFetchError(
			"host-not-allowed",
			"The endpoint was not admitted by this module.",
		);
	}
	const limits = resolveStreamLimits(options);
	const agents = createGuardedAgents({
		keepAlive: true,
		maxSockets: 8,
		timeout: limits.idleTimeoutMs,
	});
	const lookup = createPinnedLookup(state.target.host, state.addresses);
	let closed = false;
	let closing: Promise<void> | undefined;

	const lease: McpGuardedFetchLease = {
		close: () => {
			closed = true;
			closing ??= Promise.resolve().then(() => {
				agents.destroy();
			});
			return closing;
		},
		fetch: async (input, init) => {
			if (closed) {
				throw new McpDocumentFetchError("network", "The guarded fetch lease is closed.");
			}
			const url = toRequestUrl(input);
			assertGuardedUrlShape(url, state.allowQuery);
			if (url.origin !== admitted.origin) {
				throw new McpDocumentFetchError(
					"host-not-allowed",
					"Requests must stay on the admitted origin.",
				);
			}
			return await sendGuardedStreamingRequest({
				url,
				target: state.target,
				agent: agents.for(state.target.secure),
				lookup,
				staged: await stageStreamingRequest(url.host, init),
				method: (init?.method ?? "GET").toUpperCase(),
				signal: init?.signal ?? undefined,
				limits,
			});
		},
	};
	return Object.freeze(lease);
}

function resolveStreamLimits(options?: McpGuardedFetchLeaseOptions): StreamLimits {
	return {
		idleTimeoutMs: options?.idleTimeoutMs ?? MCP_STREAM_IDLE_TIMEOUT_MS,
		maxResponseBytes: options?.maxResponseBytes ?? MCP_STREAM_MAX_RESPONSE_BYTES,
		maxSseEventBytes: options?.maxSseEventBytes ?? MCP_STREAM_MAX_SSE_EVENT_BYTES,
	};
}

function toRequestUrl(input: string | URL): URL {
	if (input instanceof URL) return input;
	try {
		return new URL(input);
	} catch (cause) {
		throw new McpDocumentFetchError("insecure-url", "Request target is not an absolute URL.", {
			cause,
		});
	}
}

function assertGuardedUrlShape(url: URL, allowQuery: boolean): void {
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		(url.search !== "" && !allowQuery)
	) {
		throw new McpDocumentFetchError(
			"insecure-url",
			"Endpoint URLs must not carry userinfo, a fragment, or a query.",
		);
	}
}

async function resolveAdmittedAddresses(
	lookup: McpDocumentLookup,
	target: McpGuardedTarget,
	admitsAddress: (address: string) => boolean,
	signal: AbortSignal | undefined,
): Promise<readonly McpResolvedAddress[]> {
	if (isIP(target.host) !== 0) {
		// An IP literal already passed the policy; pin it as its own answer.
		return Object.freeze([Object.freeze({ address: target.host, family: isIP(target.host) })]);
	}
	signal?.throwIfAborted();
	const answers = await lookupAddresses(lookup, target.host, signal);
	if (answers.length === 0 || answers.length > MAX_DNS_ANSWERS) {
		throw new McpDocumentFetchError("blocked-address", "Host did not resolve usably.");
	}
	const pinned: McpResolvedAddress[] = [];
	const seen = new Set<string>();
	for (const answer of answers) {
		const family = isIP(answer.address);
		if (family === 0 || family !== answer.family) {
			throw new McpDocumentFetchError("blocked-address", "Resolver returned a malformed answer.");
		}
		// A v4-mapped answer would be judged as IPv6 by the socket while
		// carrying an IPv4 destination; refuse the whole shape.
		if (family === 6 && answer.address.toLowerCase().startsWith("::ffff:")) {
			throw new McpDocumentFetchError("blocked-address", "Host resolves to a blocked range.");
		}
		if (!admitsAddress(answer.address)) {
			throw new McpDocumentFetchError("blocked-address", "Host resolves to a blocked range.");
		}
		const key = `${String(family)}:${answer.address}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pinned.push(Object.freeze({ address: answer.address, family }));
	}
	if (pinned.length === 0) {
		throw new McpDocumentFetchError("blocked-address", "Host did not resolve usably.");
	}
	return Object.freeze(pinned);
}

function lookupAddresses(
	lookup: McpDocumentLookup,
	hostname: string,
	signal: AbortSignal | undefined,
): Promise<readonly McpResolvedAddress[]> {
	return new Promise<readonly McpResolvedAddress[]>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			reject(signal?.reason ?? new McpDocumentFetchError("timeout", "Admission was aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		lookup(hostname, (error, addresses) => {
			signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			settled = true;
			if (error !== null) {
				reject(new McpDocumentFetchError("network", "Host did not resolve.", { cause: error }));
				return;
			}
			resolve(addresses);
		});
	});
}

/**
 * Replays the answers captured at admission instead of resolving again, so the
 * socket can only reach addresses that were already judged.
 */
function createPinnedLookup(
	hostname: string,
	addresses: readonly McpResolvedAddress[],
): McpGuardedLookupHook {
	const expected = normalizeGuardedHost(hostname);
	let offset = 0;
	return (requested, lookupOptions, callback) => {
		if (normalizeGuardedHost(requested) !== expected) {
			callback(new McpDocumentFetchError("host-not-allowed", "Unpinned host lookup."), "", 0);
			return;
		}
		if (lookupOptions.all === true) {
			callback(null, addresses);
			return;
		}
		const selected = addresses[offset % addresses.length];
		offset += 1;
		if (selected === undefined) {
			callback(new McpDocumentFetchError("network", "Host did not resolve."), "", 0);
			return;
		}
		callback(null, selected.address, selected.family);
	};
}

interface StagedRequest {
	readonly headers: Record<string, string>;
	readonly body: Buffer | undefined;
}

/**
 * Encodes the `init.body` shapes the MCP transport and the SDK's OAuth helpers
 * actually send. The common ones (a JSON string, a `URLSearchParams` form,
 * raw bytes) go through the shared normalizer; anything else the platform can
 * encode — a `Blob`, `FormData`, a `ReadableStream` — is staged once so its
 * generated `Content-Type` survives. Request bodies are always small; only the
 * response side streams.
 */
async function stageStreamingRequest(
	host: string,
	init: RequestInit | undefined,
): Promise<StagedRequest> {
	const body = init?.body;
	if (
		body === undefined ||
		body === null ||
		typeof body === "string" ||
		body instanceof URLSearchParams ||
		body instanceof Uint8Array ||
		body instanceof ArrayBuffer
	) {
		const staged = normalizeGuardedRequest(host, {
			...(init?.headers === undefined ? {} : { headers: init.headers }),
			...(body === undefined || body === null ? {} : { body }),
		});
		return { headers: withIdentityEncoding(staged.headers), body: staged.body };
	}
	const encoded = new Response(body);
	const buffer = Buffer.from(await encoded.arrayBuffer());
	const headerInit: { readonly headers?: HeadersInit } =
		init?.headers === undefined ? {} : { headers: init.headers };
	const headers = withIdentityEncoding(normalizeGuardedRequest(host, headerInit).headers);
	headers["content-length"] = String(buffer.byteLength);
	const contentType = encoded.headers.get("content-type");
	if (contentType !== null && headers["content-type"] === undefined) {
		headers["content-type"] = contentType;
	}
	return { headers, body: buffer };
}

/** Byte caps are only meaningful over an undecoded body, so identity is forced. */
function withIdentityEncoding(headers: Record<string, string>): Record<string, string> {
	return { ...headers, "accept-encoding": "identity" };
}

function sendGuardedStreamingRequest(context: {
	readonly url: URL;
	readonly target: McpGuardedTarget;
	readonly agent: HttpAgent;
	readonly lookup: McpGuardedLookupHook;
	readonly staged: StagedRequest;
	readonly method: string;
	readonly signal: AbortSignal | undefined;
	readonly limits: StreamLimits;
}): Promise<Response> {
	const { url, target, limits, method } = context;
	return new Promise<Response>((resolvePromise, rejectPromise) => {
		let settled = false;
		const fail = (cause: unknown): void => {
			if (settled) return;
			settled = true;
			rejectPromise(toStreamError(cause));
		};
		const requestOptions: HttpsRequestOptions = {
			agent: context.agent,
			host: target.host,
			port: target.port,
			method,
			path: `${url.pathname}${url.search}`,
			headers: context.staged.headers,
			timeout: limits.idleTimeoutMs,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			lookup: context.lookup as never,
			...(context.signal === undefined ? {} : { signal: context.signal }),
			...(target.secure ? { servername: target.host } : {}),
		};
		const request = target.secure ? httpsRequest(requestOptions) : httpRequest(requestOptions);
		const abandon = (error: McpDocumentFetchError, response?: IncomingMessage): void => {
			response?.destroy();
			request.destroy();
			fail(error);
		};
		request.on("timeout", () => {
			request.destroy(new McpDocumentFetchError("timeout", "Streaming request timed out."));
		});
		request.on("error", fail);
		request.on("response", (response) => {
			const status = response.statusCode ?? 0;
			// `node:http` never follows redirects, which is `redirect: "manual"`
			// by construction; a 3xx is then a policy failure, not a hop.
			if (status >= 300 && status < 400) {
				abandon(
					new McpDocumentFetchError("network", "Guarded endpoints must not redirect."),
					response,
				);
				return;
			}
			if (status < 200 || status > 599) {
				abandon(
					new McpDocumentFetchError("network", "Upstream returned an invalid status."),
					response,
				);
				return;
			}
			const headers = toResponseHeaders(response.headers);
			const eventStream = isEventStream(headers.get("content-type"));
			if (!eventStream) {
				let declared: number | undefined;
				try {
					declared = parseContentLength(headers.get("content-length"));
				} catch (cause) {
					abandon(toStreamError(cause), response);
					return;
				}
				if (declared !== undefined && declared > limits.maxResponseBytes) {
					abandon(
						new McpDocumentFetchError("too-large", "Declared response exceeds the byte limit."),
						response,
					);
					return;
				}
			}
			// The socket timeout covered connect and headers. From here the
			// per-read idle window governs instead, so a consumer applying
			// backpressure to a healthy stream never trips it.
			request.setTimeout(0);
			// 204/205/304 and HEAD must not carry a body.
			const nullBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
			if (nullBody) response.resume();
			settled = true;
			resolvePromise(
				buildGuardedResponse(url, status, response.statusMessage, headers, {
					body: nullBody
						? null
						: createGuardedResponseBody(response, request, { ...limits, eventStream }),
				}),
			);
		});
		try {
			if (context.staged.body !== undefined) request.write(context.staged.body);
			request.end();
		} catch (cause) {
			fail(cause);
		}
	});
}

function buildGuardedResponse(
	url: URL,
	status: number,
	statusMessage: string | undefined,
	headers: Headers,
	init: { readonly body: ReadableStream<Uint8Array> | null },
): Response {
	const statusText =
		statusMessage !== undefined && REASON_PHRASE.test(statusMessage) ? statusMessage : "";
	const response = new Response(init.body, { status, statusText, headers });
	// `Response.url` is empty for a synthesized response; the SDK reads it when
	// resolving `WWW-Authenticate` resource metadata against the request URL.
	Object.defineProperty(response, "url", { configurable: true, value: url.href });
	return response;
}

interface SseEventBudget {
	bytes: number;
	lineHasBytes: boolean;
	afterCarriageReturn: boolean;
}

/**
 * Wraps the Node response in a web stream that meters every chunk. Ordinary
 * bodies run against a total; `text/event-stream` runs against a per-event
 * budget that resets at each blank line, because a healthy MCP session streams
 * for as long as it lives and a total would eventually kill it.
 */
function createGuardedResponseBody(
	response: IncomingMessage,
	request: ClientRequest,
	limits: StreamLimits & { readonly eventStream: boolean },
): ReadableStream<Uint8Array> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const source = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
	const reader = source.getReader();
	const budget: SseEventBudget = { bytes: 0, lineHasBytes: false, afterCarriageReturn: false };
	let total = 0;
	const tearDown = (cause: unknown): void => {
		void reader.cancel(cause).catch(() => undefined);
		request.destroy();
	};

	return new ReadableStream<Uint8Array>({
		cancel: async (reason: unknown) => {
			request.destroy();
			await reader.cancel(reason).catch(() => undefined);
		},
		pull: async (controller) => {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await readWithinIdleWindow(reader, limits.idleTimeoutMs);
			} catch (cause) {
				const error = toStreamError(cause);
				tearDown(error);
				controller.error(error);
				return;
			}
			if (result.done) {
				controller.close();
				return;
			}
			const chunk = result.value;
			try {
				if (limits.eventStream) {
					consumeSseEventBytes(budget, chunk, limits.maxSseEventBytes);
				} else {
					total += chunk.byteLength;
					if (total > limits.maxResponseBytes) {
						throw new McpDocumentFetchError("too-large", "Response exceeds the byte limit.");
					}
				}
			} catch (cause) {
				const error = toStreamError(cause);
				tearDown(error);
				controller.error(error);
				return;
			}
			controller.enqueue(chunk);
		},
	});
}

function readWithinIdleWindow(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (idleTimeoutMs <= 0) return reader.read();
	return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new McpDocumentFetchError("timeout", "Streamed response went idle."));
		}, idleTimeoutMs);
		// The socket already holds the event loop open while bytes are expected.
		timer.unref();
		reader.read().then(
			(result) => {
				clearTimeout(timer);
				resolve(result);
			},
			(cause: unknown) => {
				clearTimeout(timer);
				reject(toStreamError(cause));
			},
		);
	});
}

/**
 * Meters one SSE event. CR, LF, and CRLF all end a line; a blank line ends the
 * event, which is where the budget resets.
 */
function consumeSseEventBytes(budget: SseEventBudget, chunk: Uint8Array, maxBytes: number): void {
	for (const byte of chunk) {
		budget.bytes += 1;
		if (budget.bytes > maxBytes) {
			throw new McpDocumentFetchError("too-large", "SSE event exceeds the per-event byte limit.");
		}
		if (byte === CARRIAGE_RETURN) {
			finishSseLine(budget);
			budget.afterCarriageReturn = true;
		} else if (byte === LINE_FEED) {
			if (!budget.afterCarriageReturn) finishSseLine(budget);
			budget.afterCarriageReturn = false;
		} else {
			budget.lineHasBytes = true;
			budget.afterCarriageReturn = false;
		}
	}
}

function finishSseLine(budget: SseEventBudget): void {
	if (!budget.lineHasBytes) budget.bytes = 0;
	budget.lineHasBytes = false;
}

function toResponseHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
			continue;
		}
		headers.set(name, value);
	}
	return headers;
}

function isEventStream(contentType: string | null): boolean {
	if (contentType === null) return false;
	return contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null) return undefined;
	if (!/^(?:0|[1-9]\d*)$/.test(value)) {
		throw new McpDocumentFetchError("network", "Upstream declared an invalid content-length.");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new McpDocumentFetchError("network", "Upstream declared an invalid content-length.");
	}
	return parsed;
}

function toStreamError(cause: unknown): McpDocumentFetchError {
	if (cause instanceof McpDocumentFetchError) return cause;
	const error = cause instanceof Error ? cause : new Error(String(cause));
	if (error.name === "AbortError" || Reflect.get(error, "code") === "ABORT_ERR") {
		return new McpDocumentFetchError("timeout", "Streaming request was aborted.", { cause: error });
	}
	return new McpDocumentFetchError("network", "Streaming request failed.", { cause: error });
}
