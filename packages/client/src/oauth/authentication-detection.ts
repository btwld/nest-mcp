import {
	Client,
	StreamableHTTPClientTransport,
	type FetchLike,
} from "@modelcontextprotocol/client";

import {
	McpClientOAuthBootstrap,
	McpClientOAuthBootstrapError,
	parseMcpClientOAuthBootstrapChallenge,
	type McpClientOAuthBootstrapDiscoveryResult,
	type McpClientOAuthBootstrapEndpointPolicy,
	type McpClientOAuthBootstrapErrorCode,
} from "./bootstrap.ts";

export interface McpClientAuthenticationDetectionInput {
	readonly serverUrl: string;
	/** Already admitted, credential-free fetch. The host owns DNS pinning and network policy. */
	readonly fetch: FetchLike;
	/** Guarded OAuth metadata fetch; defaults to fetch. Useful with an endpoint-only MCP lease. */
	readonly discoveryFetch?: FetchLike;
	/** The same policy used by OAuth bootstrap, including all generated discovery URLs. */
	readonly endpointPolicy: McpClientOAuthBootstrapEndpointPolicy;
	/** Host cancellation/deadline, preserved as a rejection with its original reason. */
	readonly signal: AbortSignal;
	/** Whole detection budget, default 10 seconds, at most 60 seconds. Cleanup adds at most 1 second. */
	readonly timeoutMs?: number;
	/** Aggregate response bytes, including SSE framing and metadata. Default 256 KiB, at most 1 MiB. */
	readonly maxResponseBytes?: number;
}

export type McpClientAuthenticationDetectionReason =
	| "invalid-options"
	| "endpoint-rejected"
	| "network-error"
	| "invalid-response"
	| "response-too-large"
	| "request-limit"
	| "timeout"
	| "http-error"
	| "unsupported-authentication"
	| "oauth-discovery-failed"
	| "cleanup-failed";

export type McpClientAuthenticationDetectionResult =
	| {
			/** A credential-free MCP connection succeeded; later operations may still require OAuth. */
			readonly kind: "anonymous";
			readonly protocolVersion: string;
			readonly protocolEra: "modern" | "legacy";
			/** Schema-validated, bounded, self-reported display data; never an identity attestation. */
			readonly serverInfo?: {
				readonly name: string;
				readonly version: string;
				readonly title?: string;
			};
	  }
	| {
			/** Authorization was denied and OAuth bootstrap validated the advertised resource. */
			readonly kind: "oauth-required";
			/** Enrollment, issuer selection, and strict-protocol compatibility remain host decisions. */
			readonly discovery: McpClientOAuthBootstrapDiscoveryResult;
	  }
	| {
			readonly kind: "indeterminate";
			readonly reason: McpClientAuthenticationDetectionReason;
			readonly httpStatus?: number;
			readonly discoveryErrorCode?: McpClientOAuthBootstrapErrorCode;
	  };

/**
 * Passive Streamable HTTP detection using the SDK's modern discovery / legacy handshake.
 * No credentials, registration, browser navigation, token requests, or feature invocation.
 * Never infer anonymous access from a status code or missing OAuth metadata. HTTP+SSE (2024)
 * endpoints are not followed. The caller must always release its admitted network lease.
 */
export async function detectMcpClientAuthentication(
	input: McpClientAuthenticationDetectionInput,
): Promise<McpClientAuthenticationDetectionResult> {
	if (typeof input !== "object" || input === null || !(input.signal instanceof AbortSignal))
		return indeterminate("invalid-options");
	input.signal.throwIfAborted();
	const timeoutMs = input.timeoutMs ?? 10_000;
	const maxResponseBytes = input.maxResponseBytes ?? 262_144;
	let endpoint: URL;
	try {
		endpoint = new URL(input.serverUrl);
		if (
			typeof input.serverUrl !== "string" ||
			input.serverUrl.length > 4_096 ||
			!["http:", "https:"].includes(endpoint.protocol) ||
			endpoint.username !== "" ||
			endpoint.password !== "" ||
			endpoint.hash !== "" ||
			typeof input.fetch !== "function" ||
			(input.discoveryFetch !== undefined && typeof input.discoveryFetch !== "function") ||
			typeof input.endpointPolicy !== "function" ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > 60_000 ||
			!Number.isSafeInteger(maxResponseBytes) ||
			maxResponseBytes < 1 ||
			maxResponseBytes > 1_048_576
		)
			return indeterminate("invalid-options");
	} catch {
		return indeterminate("invalid-options");
	}

	const scope = new DetectionScope(input, maxResponseBytes);
	const timer = setTimeout(() => scope.stop("timeout"), timeoutMs);
	let denied: { status: number; header?: string } | undefined;
	let accepting = true;
	const pendingGets = new Set<Promise<Response>>();
	const transportFetch: FetchLike = (url, init) => {
		const request = (async () => {
			if (!accepting || denied !== undefined) throw new DetectionFailure("http-error");
			if (String(url) !== endpoint.href) throw new DetectionFailure("endpoint-rejected");
			const method = init?.method;
			const rpcMethod = method === "POST" ? outgoingMethod(init?.body) : undefined;
			if (
				method !== "GET" &&
				(method !== "POST" ||
					!["server/discover", "initialize", "notifications/initialized"].includes(rpcMethod ?? ""))
			) {
				scope.stop("invalid-response");
				throw new DetectionFailure("invalid-response");
			}
			const response = await scope.fetch(url, init);
			if (response.status === 401 || response.status === 403) {
				const header = response.headers.get("www-authenticate");
				denied = { status: response.status, ...(header === null ? {} : { header }) };
				scope.cancel(response);
				throw new DetectionFailure("http-error");
			}
			if (method === "GET") {
				// The SDK opens the optional legacy GET stream after initialized. Only its
				// headers matter here; do not wait for a stream that is designed to stay open.
				scope.cancel(response);
				if (!response.ok && response.status !== 405) {
					scope.stop("http-error");
					throw new DetectionFailure("http-error");
				}
				return new Response(null, { status: response.status, headers: response.headers });
			}
			if (!response.ok && ![400, 404, 405].includes(response.status)) {
				scope.cancel(response);
				scope.stop("http-error");
				throw new DetectionFailure("http-error");
			}
			if (rpcMethod === "notifications/initialized" && response.ok) {
				scope.cancel(response);
				if (response.status !== 202) {
					scope.stop("invalid-response");
					throw new DetectionFailure("invalid-response");
				}
				return new Response(null, { status: 202, headers: response.headers });
			}
			return response;
		})();
		if (init?.method === "GET") pendingGets.add(request);
		return request;
	};
	const transport = new StreamableHTTPClientTransport(endpoint, {
		fetch: transportFetch,
		reconnectionOptions: {
			maxRetries: 0,
			initialReconnectionDelay: 1_000,
			maxReconnectionDelay: 1_000,
			reconnectionDelayGrowFactor: 1,
		},
	});
	const client = new Client(
		{ name: "nest-mcp-authentication-detection", version: "1" },
		{ capabilities: {}, versionNegotiation: { mode: "auto", probe: { timeoutMs, maxRetries: 0 } } },
	);
	let result: McpClientAuthenticationDetectionResult;
	try {
		try {
			await withSignal(
				client.connect(transport, { signal: scope.signal, timeout: timeoutMs }),
				scope.signal,
			);
			await withSignal(Promise.all(pendingGets), scope.signal);
			if (denied !== undefined) throw new DetectionFailure("http-error");
			const protocolVersion = client.getNegotiatedProtocolVersion();
			const protocolEra = client.getProtocolEra();
			if (protocolVersion === undefined || protocolEra === undefined)
				throw new DetectionFailure("invalid-response");
			const serverInfo = boundedServerInfo(client.getServerVersion());
			result = Object.freeze({
				kind: "anonymous",
				protocolVersion,
				protocolEra,
				...(serverInfo === undefined ? {} : { serverInfo }),
			});
		} catch (error) {
			if (denied === undefined || scope.signal.aborted) throw error;
			const { status, header } = denied;
			let bearer;
			try {
				bearer = header === undefined ? undefined : parseMcpClientOAuthBootstrapChallenge(header);
			} catch {
				throw new DetectionFailure("unsupported-authentication");
			}
			// A bare 401 supports well-known discovery. Basic/API-key auth and bare
			// 403 (including origin rejection) do not establish an OAuth challenge.
			if (
				(header !== undefined && bearer === undefined) ||
				(status === 403 && bearer === undefined)
			) {
				throw new DetectionFailure("unsupported-authentication");
			}
			const bootstrap = new McpClientOAuthBootstrap({
				fetch: scope.discoveryFetch,
				endpointPolicy: input.endpointPolicy,
			});
			const discovery = await withSignal(
				bootstrap.discover({
					serverUrl: endpoint.href,
					...(header === undefined ? {} : { wwwAuthenticate: header }),
					signal: scope.signal,
				}),
				scope.signal,
			);
			result = Object.freeze({ kind: "oauth-required", discovery });
		}
	} catch (error) {
		result = indeterminate(
			scope.failure ??
				(error instanceof DetectionFailure
					? error.reason
					: error instanceof McpClientOAuthBootstrapError
						? "oauth-discovery-failed"
						: "invalid-response"),
			denied?.status ?? scope.httpStatus,
			error instanceof McpClientOAuthBootstrapError ? error.code : undefined,
		);
	} finally {
		accepting = false;
		clearTimeout(timer);
	}

	// The SDK's close() only aborts streams; it does not terminate legacy sessions.
	// Use a fresh bounded cleanup signal because connect() may already have closed
	// the SDK transport on error. Never outlive cancellation supplied by the host.
	const cleaned = await scope.close(client, transport, endpoint);
	input.signal.throwIfAborted();
	if (!cleaned && result.kind === "anonymous") return indeterminate("cleanup-failed");
	return result;
}

class DetectionFailure extends Error {
	constructor(readonly reason: McpClientAuthenticationDetectionReason) {
		super("MCP authentication detection did not complete.");
	}
}

class DetectionScope {
	readonly #controller = new AbortController();
	readonly signal: AbortSignal;
	readonly #cancellations = new Set<Promise<unknown>>();
	readonly #readers = new Map<Response, () => void>();
	#bytes = 0;
	#requests = 0;
	failure: McpClientAuthenticationDetectionReason | undefined;
	httpStatus: number | undefined;

	constructor(
		readonly input: McpClientAuthenticationDetectionInput,
		readonly maximum: number,
	) {
		this.signal = AbortSignal.any([input.signal, this.#controller.signal]);
	}

	stop(reason: McpClientAuthenticationDetectionReason): void {
		this.failure ??= reason;
		this.#controller.abort(new DetectionFailure(reason));
	}

	fetch: FetchLike = (url, init) => this.#fetch(this.input.fetch, url, init);
	discoveryFetch: FetchLike = (url, init) =>
		this.#fetch(this.input.discoveryFetch ?? this.input.fetch, url, init);

	async #fetch(
		fetch: FetchLike,
		url: Parameters<FetchLike>[0],
		init: RequestInit | undefined,
	): Promise<Response> {
		this.signal.throwIfAborted();
		if (++this.#requests > 12) {
			this.stop("request-limit");
			throw new DetectionFailure("request-limit");
		}
		const signal = AbortSignal.any([this.signal, ...(init?.signal == null ? [] : [init.signal])]);
		const pending = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return fetch(url, credentialFreeInit(init, signal));
		});
		// A host fetch that settles after cancellation must still have its body cancelled.
		const request = Promise.resolve(pending).then((response) => {
			if (signal.aborted) {
				this.#cancelBody(response);
				signal.throwIfAborted();
			}
			return response;
		});
		let response: Response;
		try {
			response = await withSignal(request, signal);
		} catch {
			signal.throwIfAborted();
			this.stop("network-error");
			throw new DetectionFailure("network-error");
		}
		if (
			response.redirected ||
			(response.status >= 300 && response.status < 400) ||
			(response.url !== "" && response.url !== String(url))
		) {
			this.#cancelBody(response);
			this.stop("endpoint-rejected");
			throw new DetectionFailure("endpoint-rejected");
		}
		this.httpStatus = response.status;
		if (
			(response.headers.get("www-authenticate")?.length ?? 0) > 8_192 ||
			(response.headers.get("mcp-session-id")?.length ?? 0) > 1_024
		) {
			this.#cancelBody(response);
			this.stop("response-too-large");
			throw new DetectionFailure("response-too-large");
		}
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId !== null && !/^[\x21-\x7e]+$/.test(sessionId)) {
			this.#cancelBody(response);
			this.stop("invalid-response");
			throw new DetectionFailure("invalid-response");
		}
		return this.#bounded(response, signal);
	}

	cancel(response: Response): void {
		this.#readers.get(response)?.();
	}

	#cancelBody(response: Response): void {
		if (response.body !== null) this.#cancellations.add(response.body.cancel().catch(() => {}));
	}

	#bounded(response: Response, signal: AbortSignal): Response {
		if (response.body === null) return response;
		const reader = response.body.getReader();
		let ended = false;
		let wrapped: Response;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const detach = () => {
			signal.removeEventListener("abort", abort);
			this.#readers.delete(wrapped);
		};
		const cancel = () => {
			if (ended) return;
			ended = true;
			detach();
			controller.close();
			this.#cancellations.add(
				reader
					.cancel()
					.catch(() => {})
					.finally(() => reader.releaseLock()),
			);
		};
		const abort = () => {
			if (ended) return;
			controller.error(new DetectionFailure(this.failure ?? "invalid-response"));
			ended = true;
			detach();
			this.#cancellations.add(
				reader
					.cancel()
					.catch(() => {})
					.finally(() => reader.releaseLock()),
			);
		};
		const stream = new ReadableStream<Uint8Array>(
			{
				start(value) {
					controller = value;
				},
				pull: async () => {
					try {
						const chunk = await reader.read();
						if (ended) return;
						if (chunk.done) {
							ended = true;
							detach();
							reader.releaseLock();
							controller.close();
							return;
						}
						this.#bytes += chunk.value.byteLength;
						if (this.#bytes > this.maximum) {
							this.stop("response-too-large");
							return;
						}
						controller.enqueue(chunk.value);
					} catch {
						if (!ended) this.stop("network-error");
					}
				},
				cancel: () => {
					if (!ended) {
						ended = true;
						detach();
						this.#cancellations.add(
							reader
								.cancel()
								.catch(() => {})
								.finally(() => reader.releaseLock()),
						);
					}
				},
			},
			{ highWaterMark: 0 },
		);
		wrapped = new Response(stream, { status: response.status, headers: response.headers });
		this.#readers.set(wrapped, cancel);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		return wrapped;
	}

	async close(
		client: Client,
		transport: StreamableHTTPClientTransport,
		endpoint: URL,
	): Promise<boolean> {
		const cleanup = new AbortController();
		const timer = setTimeout(() => cleanup.abort(), 1_000);
		const signal = AbortSignal.any([this.input.signal, cleanup.signal]);
		try {
			const sessionId = transport.sessionId;
			// Close streams immediately, before waiting for session termination.
			this.#controller.abort();
			// Initiate both closes even when the host signal is already aborted: during
			// negotiation the raw transport has not yet been attached to Client.
			await withSignal(Promise.all([client.close(), transport.close()]), signal);
			if (sessionId !== undefined && /^[\x21-\x7e]{1,1024}$/.test(sessionId)) {
				signal.throwIfAborted();
				const headers = new Headers({ "mcp-session-id": sessionId });
				if (transport.protocolVersion !== undefined)
					headers.set("mcp-protocol-version", transport.protocolVersion);
				const request = Promise.resolve(
					this.input.fetch(endpoint, credentialFreeInit({ method: "DELETE", headers }, signal)),
				).then((response) => {
					this.#cancelBody(response);
					return response;
				});
				const response = await withSignal(request, signal);
				if (
					response.redirected ||
					(response.url !== "" && response.url !== endpoint.href) ||
					(!response.ok && response.status !== 405)
				)
					return false;
			}
			await withSignal(Promise.all(this.#cancellations), signal);
			return true;
		} catch {
			return false;
		} finally {
			cleanup.abort();
			clearTimeout(timer);
		}
	}
}

function credentialFreeInit(init: RequestInit | undefined, signal: AbortSignal): RequestInit {
	const headers = new Headers(init?.headers);
	for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
	return { ...init, headers, signal, credentials: "omit", redirect: "error", cache: "no-store" };
}

function outgoingMethod(body: unknown): string | undefined {
	if (typeof body !== "string") return undefined;
	const value: unknown = JSON.parse(body);
	return typeof value === "object" &&
		value !== null &&
		"method" in value &&
		typeof value.method === "string"
		? value.method
		: undefined;
}

function boundedServerInfo(info: ReturnType<Client["getServerVersion"]>) {
	if (info === undefined || info.name.length > 256 || info.version.length > 128) return undefined;
	return Object.freeze({
		name: info.name,
		version: info.version,
		...(info.title === undefined || info.title.length > 256 ? {} : { title: info.title }),
	});
}

function indeterminate(
	reason: McpClientAuthenticationDetectionReason,
	httpStatus?: number,
	discoveryErrorCode?: McpClientOAuthBootstrapErrorCode,
): McpClientAuthenticationDetectionResult {
	return Object.freeze({
		kind: "indeterminate",
		reason,
		...(httpStatus === undefined ? {} : { httpStatus }),
		...(discoveryErrorCode === undefined ? {} : { discoveryErrorCode }),
	});
}

function withSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}
