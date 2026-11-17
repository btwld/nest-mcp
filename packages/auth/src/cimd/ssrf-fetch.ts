import { lookup as dnsLookup } from "node:dns";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, isIPv4 } from "node:net";

export interface McpDocumentFetchOptions {
	readonly maxBytes: number;
	readonly totalTimeoutMs: number;
	readonly accept: string;
	readonly signal?: AbortSignal;
}

export interface McpFetchedDocument {
	readonly status: number;
	readonly contentType: string | undefined;
	readonly cacheControl: string | undefined;
	readonly body: string;
}

/**
 * Outbound document transport seam. The Node implementation hardens against
 * SSRF; non-Node hosts substitute their own guarded transport.
 */
export interface McpHttpDocumentFetcher {
	fetchDocument(url: URL, options: McpDocumentFetchOptions): Promise<McpFetchedDocument>;
}

export type McpDocumentFetchFailure =
	"insecure-url" | "blocked-address" | "host-not-allowed" | "too-large" | "timeout" | "network";

export class McpDocumentFetchError extends Error {
	readonly code = "MCP_DOCUMENT_FETCH_FAILED";

	constructor(
		readonly reason: McpDocumentFetchFailure,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "McpDocumentFetchError";
	}
}

/** One DNS answer: the address literal plus its IP family (4 or 6). */
export interface McpResolvedAddress {
	readonly address: string;
	readonly family: number;
}

export type McpDocumentLookup = (
	hostname: string,
	callback: (error: Error | null, addresses: readonly McpResolvedAddress[]) => void,
) => void;

/**
 * Scheme and host admission shared by every guarded transport in this package.
 * Both switches are fail-closed: leaving them unset preserves the historical
 * behavior (https only, any host outside the blocked ranges).
 */
export interface McpGuardedHostPolicyOptions {
	/**
	 * Exact hostnames admitted for outbound requests, compared after
	 * normalization (lowercased, one trailing dot removed, IPv6 brackets
	 * stripped). Unset admits any host that is not in a blocked range.
	 */
	readonly allowedHosts?: readonly string[];
	/**
	 * Permits `http:` to a host whose every resolved address is loopback
	 * (127.0.0.0/8 or ::1) — the local-dev MCP server case. A mixed answer set
	 * still fails, and `https:` keeps blocking loopback either way.
	 */
	readonly allowLoopbackHttp?: boolean;
	/** Additional address predicate; blocking is additive to the built-in ranges. */
	readonly isAddressBlocked?: (address: string) => boolean;
}

export interface McpNodeDocumentFetcherOptions extends McpGuardedHostPolicyOptions {
	/** Injectable resolver for tests; defaults to `dns.lookup` with `all: true`. */
	readonly lookup?: McpDocumentLookup;
	/** Idle-socket timeout; the total budget comes from each fetch call. */
	readonly socketTimeoutMs?: number;
}

const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;
const USER_AGENT = "nest-mcp-auth";

/** The connection an admitted URL resolves to; `secure` picks https vs loopback http. */
export interface McpGuardedTarget {
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
}

export interface McpGuardedHostPolicy {
	/** Judges scheme, allowlist, and IP-literal hosts before any network I/O. */
	admit(url: URL): McpGuardedTarget;
	/** The per-address predicate the connect-time lookup hook must satisfy. */
	admitsAddress(target: McpGuardedTarget): (address: string) => boolean;
}

/**
 * Builds the shared scheme/host policy. Kept separate from the transports so
 * the buffered fetch, the streaming fetch, and endpoint admission all judge a
 * URL by exactly the same rules.
 */
export function createGuardedHostPolicy(
	options?: McpGuardedHostPolicyOptions,
): McpGuardedHostPolicy {
	const extraBlock = options?.isAddressBlocked ?? ((): boolean => false);
	const allowLoopbackHttp = options?.allowLoopbackHttp === true;
	const allowedHosts =
		options?.allowedHosts === undefined
			? undefined
			: new Set(options.allowedHosts.map(normalizeGuardedHost));
	const admitsAddress =
		(target: McpGuardedTarget) =>
		(address: string): boolean =>
			target.secure
				? !isBlockedDocumentAddress(address) && !extraBlock(address)
				: isLoopbackAddress(address) && !extraBlock(address);

	return {
		admit: (url) => {
			const host = normalizeGuardedHost(url.hostname);
			const secure = url.protocol === "https:";
			if (!secure && !(url.protocol === "http:" && allowLoopbackHttp)) {
				throw new McpDocumentFetchError(
					"insecure-url",
					"Guarded requests must use the https scheme.",
				);
			}
			if (allowedHosts !== undefined && !allowedHosts.has(host)) {
				throw new McpDocumentFetchError(
					"host-not-allowed",
					"Host is not in the configured allowlist.",
				);
			}
			const target: McpGuardedTarget = {
				host,
				port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
				secure,
			};
			// IP-literal hosts never reach the lookup hook, so judge them here.
			if (isIP(host) !== 0 && !admitsAddress(target)(host)) {
				throw new McpDocumentFetchError(
					"blocked-address",
					secure
						? "Host is in a blocked address range."
						: "Loopback http requires a loopback address.",
				);
			}
			return target;
		},
		admitsAddress,
	};
}

/**
 * Canonical host form for exact allowlist comparison: lowercased, one trailing
 * dot removed (`example.com.` is the same name as `example.com`), and IPv6
 * brackets stripped so `[::1]` compares as `::1`.
 */
export function normalizeGuardedHost(hostname: string): string {
	const trimmed = hostname.trim().toLowerCase();
	return stripBrackets(trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed);
}

/**
 * True only for 127.0.0.0/8 and ::1 — the sole ranges `allowLoopbackHttp`
 * opens. IPv4-mapped forms such as `::ffff:127.0.0.1` are deliberately not
 * loopback here, so they cannot smuggle themselves through that door.
 */
export function isLoopbackAddress(address: string): boolean {
	const candidate = stripBrackets(address.trim());
	if (isIPv4(candidate)) return Number(candidate.split(".")[0]) === 127;
	if (isIP(candidate) !== 6) return false;
	const groups = expandIpv6(candidate);
	if (groups === undefined) return false;
	return groups.length === 8 && groups.every((group, index) => group === (index === 7 ? 1 : 0));
}

/**
 * Lazily paired https/http agents. The http side only ever materializes for an
 * `allowLoopbackHttp` target, and `destroy` gives leases a deterministic close.
 */
export function createGuardedAgents(options: {
	readonly keepAlive: boolean;
	readonly maxSockets: number;
	readonly timeout?: number;
}): {
	readonly for: (secure: boolean) => HttpAgent;
	readonly destroy: () => void;
} {
	const secureAgent = new HttpsAgent(options);
	let plainAgent: HttpAgent | undefined;
	return {
		for: (secure) => {
			if (secure) return secureAgent;
			plainAgent ??= new HttpAgent(options);
			return plainAgent;
		},
		destroy: () => {
			secureAgent.destroy();
			plainAgent?.destroy();
		},
	};
}

/**
 * `node:https`-based fetcher with connect-time DNS pinning: the `lookup` hook
 * validates exactly the addresses the socket will use, leaving no
 * DNS-rebinding window between check and connect. Redirects are never
 * followed (a 3xx is surfaced as its status for the caller to reject),
 * responses stream through a hard byte cap, and IP-literal hosts are judged
 * directly without DNS.
 */
export function createNodeDocumentFetcher(
	options?: McpNodeDocumentFetcherOptions,
): McpHttpDocumentFetcher {
	const resolve = options?.lookup ?? defaultGuardedLookup;
	const policy = createGuardedHostPolicy(options);
	const socketTimeoutMs = options?.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
	const agents = createGuardedAgents({ keepAlive: false, maxSockets: 8 });

	return {
		fetchDocument: async (url, fetchOptions) => {
			const target = policy.admit(url);
			const signals = [AbortSignal.timeout(fetchOptions.totalTimeoutMs)];
			if (fetchOptions.signal !== undefined) signals.push(fetchOptions.signal);
			return fetchOnce(url, fetchOptions, {
				agent: agents.for(target.secure),
				target,
				resolve,
				admitsAddress: policy.admitsAddress(target),
				socketTimeoutMs,
				signal: AbortSignal.any(signals),
			});
		},
	};
}

function fetchOnce(
	url: URL,
	options: McpDocumentFetchOptions,
	transport: {
		readonly agent: HttpAgent;
		readonly target: McpGuardedTarget;
		readonly resolve: McpDocumentLookup;
		readonly admitsAddress: (address: string) => boolean;
		readonly socketTimeoutMs: number;
		readonly signal: AbortSignal;
	},
): Promise<McpFetchedDocument> {
	return new Promise<McpFetchedDocument>((resolvePromise, rejectPromise) => {
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			rejectPromise(translateFailure(error, transport.signal));
		};
		const succeed = (document: McpFetchedDocument): void => {
			if (settled) return;
			settled = true;
			resolvePromise(document);
		};
		const requestOptions: HttpsRequestOptions = {
			agent: transport.agent,
			host: transport.target.host,
			port: transport.target.port,
			method: "GET",
			path: `${url.pathname}${url.search}`,
			headers: {
				accept: options.accept,
				"accept-encoding": "identity",
				host: url.host,
				"user-agent": USER_AGENT,
			},
			signal: transport.signal,
			timeout: transport.socketTimeoutMs,
			// The socket's own resolution is the validation point: the addresses
			// judged here are exactly the addresses the connection uses.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			lookup: guardedLookup(transport.resolve, transport.admitsAddress) as never,
			...(transport.target.secure ? { servername: transport.target.host } : {}),
		};
		const request = transport.target.secure
			? httpsRequest(requestOptions)
			: httpRequest(requestOptions);
		request.on("response", (response) => {
			const status = response.statusCode ?? 0;
			const contentType = headerValue(response.headers["content-type"]);
			const cacheControl = headerValue(response.headers["cache-control"]);
			const chunks: Buffer[] = [];
			let total = 0;
			response.on("data", (chunk: Buffer) => {
				total += chunk.byteLength;
				if (total > options.maxBytes) {
					response.destroy();
					request.destroy();
					fail(new McpDocumentFetchError("too-large", "Document exceeds the byte limit."));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => {
				succeed({
					status,
					contentType,
					cacheControl,
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
			response.on("error", fail);
		});
		request.on("timeout", () => {
			request.destroy(new McpDocumentFetchError("timeout", "Document fetch timed out."));
		});
		request.on("error", fail);
		request.end();
	});
}

/**
 * Fetch-compatible face accepted by the SDK's OAuth client helpers. The `init`
 * shape mirrors the standard `RequestInit` fields these helpers actually use —
 * `headers` may be a `Headers` instance and `body` a `URLSearchParams`, so the
 * implementation must normalize both rather than assume plain values.
 */
export type McpFetchLike = (
	input: string | URL,
	init?: {
		method?: string;
		headers?: HeadersInit;
		body?: BodyInit | null;
		signal?: AbortSignal;
	},
) => Promise<Response>;

export interface McpSsrfGuardedFetchOptions extends McpGuardedHostPolicyOptions {
	readonly lookup?: McpDocumentLookup;
	readonly totalTimeoutMs?: number;
	readonly maxResponseBytes?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;

/**
 * A `FetchLike` for HTTPS requests to OAuth endpoints with the same
 * connect-time DNS pinning as the document fetcher: no redirects, blocked
 * private/link-local/NAT64 ranges, and a bounded response body. Suitable for
 * discovery and token endpoints (small JSON), not streaming.
 */
export function createSsrfGuardedFetch(options?: McpSsrfGuardedFetchOptions): McpFetchLike {
	const resolve = options?.lookup ?? defaultGuardedLookup;
	const policy = createGuardedHostPolicy(options);
	const totalTimeoutMs = options?.totalTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const agents = createGuardedAgents({ keepAlive: false, maxSockets: 8 });

	return (input, init) => {
		let url: URL;
		let target: McpGuardedTarget;
		try {
			url = input instanceof URL ? input : new URL(input);
			target = policy.admit(url);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const signals = [AbortSignal.timeout(totalTimeoutMs)];
		if (init?.signal !== undefined) signals.push(init.signal);
		const signal = AbortSignal.any(signals);
		// Normalize headers (Headers | record | tuples) into a plain object, and
		// the body (string | URLSearchParams | Uint8Array) into a Buffer, so the
		// SDK's `fetchFn(url, { headers: new Headers(...), body: new URLSearchParams(...) })`
		// carries its Content-Type and Basic auth intact.
		let outgoing: Record<string, string>;
		let payload: Buffer | undefined;
		try {
			({ headers: outgoing, body: payload } = normalizeGuardedRequest(url.host, init));
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return new Promise<Response>((resolvePromise, rejectPromise) => {
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				rejectPromise(translateFailure(error, signal));
			};
			const requestOptions: HttpsRequestOptions = {
				agent: agents.for(target.secure),
				host: target.host,
				port: target.port,
				method: init?.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				headers: outgoing,
				signal,
				timeout: totalTimeoutMs,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				lookup: guardedLookup(resolve, policy.admitsAddress(target)) as never,
				...(target.secure ? { servername: target.host } : {}),
			};
			const request = target.secure ? httpsRequest(requestOptions) : httpRequest(requestOptions);
			request.on("response", (response) => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400) {
					response.destroy();
					request.destroy();
					fail(new McpDocumentFetchError("network", "OAuth endpoints must not redirect."));
					return;
				}
				const chunks: Buffer[] = [];
				let total = 0;
				response.on("data", (chunk: Buffer) => {
					total += chunk.byteLength;
					if (total > maxResponseBytes) {
						response.destroy();
						request.destroy();
						fail(new McpDocumentFetchError("too-large", "OAuth response exceeds the byte limit."));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (settled) return;
					if (status < 200 || status > 599) {
						fail(new McpDocumentFetchError("network", "Upstream returned an invalid status."));
						return;
					}
					settled = true;
					const headers = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (typeof value === "string") headers.set(name, value);
						else if (Array.isArray(value)) headers.set(name, value.join(", "));
					}
					// 204/205/304 must not carry a body; passing bytes throws in the Response ctor.
					const nullBody = status === 204 || status === 205 || status === 304;
					resolvePromise(
						new Response(nullBody ? null : Buffer.concat(chunks), { status, headers }),
					);
				});
				response.on("error", fail);
			});
			request.on("timeout", () => {
				request.destroy(new McpDocumentFetchError("timeout", "OAuth request timed out."));
			});
			request.on("error", fail);
			try {
				if (payload !== undefined) request.write(payload);
				request.end();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
}

/**
 * Normalizes SDK-shaped `RequestInit` headers/body into the plain forms the
 * Node HTTPS request needs. Exported for regression coverage: a `Headers`
 * instance and a `URLSearchParams` body must survive intact (Content-Type and
 * Basic-auth headers preserved, form body serialized, not dropped or thrown on).
 */
export function normalizeGuardedRequest(
	host: string,
	init: { readonly headers?: HeadersInit; readonly body?: BodyInit | null } | undefined,
): { readonly headers: Record<string, string>; readonly body: Buffer | undefined } {
	const headers = normalizeHeaders(host, init?.headers);
	const body = normalizeBody(init?.body);
	if (body !== undefined) {
		headers["content-length"] = String(body.byteLength);
		if (init?.body instanceof URLSearchParams && headers["content-type"] === undefined) {
			headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
		}
	}
	return { headers, body };
}

function normalizeHeaders(host: string, headers: HeadersInit | undefined): Record<string, string> {
	const outgoing: Record<string, string> = { host };
	if (headers === undefined) return outgoing;
	// Headers, [name,value][] and Record all iterate uniformly through `new Headers`.
	new Headers(headers).forEach((value, name) => {
		if (name.toLowerCase() === "host") return;
		outgoing[name] = value;
	});
	return outgoing;
}

function normalizeBody(body: BodyInit | null | undefined): Buffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	throw new McpDocumentFetchError(
		"network",
		"Unsupported request body type for the guarded fetch.",
	);
}

export type McpGuardedLookupHook = (
	hostname: string,
	lookupOptions: { all?: boolean },
	callback: (
		error: Error | null,
		address: string | readonly McpResolvedAddress[],
		family?: number,
	) => void,
) => void;

/**
 * The connect-time validation point. Every answer must pass `admitsAddress` —
 * a mixed result set is treated as a rebinding attempt — and the addresses
 * handed back are exactly the addresses the socket connects to.
 */
export function guardedLookup(
	resolve: McpDocumentLookup,
	admitsAddress: (address: string) => boolean,
): McpGuardedLookupHook {
	return (hostname, lookupOptions, callback) => {
		resolve(hostname, (error, addresses) => {
			if (error !== null) {
				callback(error, "", 0);
				return;
			}
			if (addresses.length === 0) {
				callback(new McpDocumentFetchError("network", "Host did not resolve."), "", 0);
				return;
			}
			if (!addresses.every((entry) => admitsAddress(entry.address))) {
				callback(
					new McpDocumentFetchError("blocked-address", "Host resolves to a blocked range."),
					"",
					0,
				);
				return;
			}
			if (lookupOptions.all === true) {
				callback(null, addresses);
				return;
			}
			const first = addresses[0];
			if (first === undefined) {
				callback(new McpDocumentFetchError("network", "Host did not resolve."), "", 0);
				return;
			}
			callback(null, first.address, first.family);
		});
	};
}

function translateFailure(error: Error, signal: AbortSignal): Error {
	if (error instanceof McpDocumentFetchError) return error;
	const aborted =
		signal.aborted || error.name === "AbortError" || Reflect.get(error, "code") === "ABORT_ERR";
	if (aborted) {
		return new McpDocumentFetchError("timeout", "Document fetch timed out.", { cause: error });
	}
	return new McpDocumentFetchError("network", "Document fetch failed.", { cause: error });
}

/** `dns.lookup` with `all: true`, projected onto the injectable seam. */
export function defaultGuardedLookup(
	hostname: string,
	callback: (error: Error | null, addresses: readonly McpResolvedAddress[]) => void,
): void {
	dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
		if (error !== null && error !== undefined) {
			callback(error, []);
			return;
		}
		callback(
			null,
			addresses.map((entry) => ({ address: entry.address, family: entry.family })),
		);
	});
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function stripBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Blocked outbound ranges: loopback, RFC 1918/6598 private space, link-local
 * (cloud metadata), documentation/benchmark nets, multicast/reserved space,
 * and every IPv6 form that can smuggle one of those (v4-mapped, NAT64, 6to4,
 * Teredo, ULA, link-local).
 */
export function isBlockedDocumentAddress(address: string): boolean {
	const candidate = stripBrackets(address.trim());
	if (isIPv4(candidate)) return isBlockedIpv4(candidate);
	if (isIP(candidate) === 6) return isBlockedIpv6(candidate);
	// Not an IP literal at all: refuse rather than guess.
	return true;
}

function isBlockedIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	const [a = 0, b = 0] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 doc
	if (a === 192 && b === 88) return true; // 6to4 relay anycast
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51) return true; // 198.51.100/24 doc
	if (a === 203 && b === 0) return true; // 203.0.113/24 doc
	if (a >= 224) return true; // multicast + reserved + broadcast
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const groups = expandIpv6(address);
	if (groups === undefined) return true;
	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
	const isZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	// v4-mapped/embedded forms defer to the IPv4 blocklist for the inner address.
	if (isZeroPrefix && g5 === 0xff_ff) return isBlockedIpv4(embeddedIpv4(g6, g7)); // ::ffff:0:0/96
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xff_ff && g5 === 0) {
		return isBlockedIpv4(embeddedIpv4(g6, g7)); // ::ffff:0:0:0/96 (v4-translated)
	}
	if (g0 === 0x64 && g1 === 0xff_9b) return true; // NAT64 64:ff9b::/96 + 64:ff9b:1::/48
	if (g0 === 0x20_02) return true; // 6to4 2002::/16 embeds arbitrary IPv4
	// Allow only global unicast (2000::/3); every other range is non-routable,
	// reserved, or special-use, which future-proofs against new bad prefixes.
	if ((g0 & 0xe0_00) !== 0x20_00) return true;
	if (g0 === 0x20_01 && g1 === 0x0d_b8) return true; // 2001:db8::/32 documentation
	if (g0 === 0x20_01 && g1 === 0) return true; // Teredo 2001::/32
	return false;
}

function embeddedIpv4(high: number, low: number): string {
	return `${String(high >>> 8)}.${String(high & 0xff)}.${String(low >>> 8)}.${String(low & 0xff)}`;
}

function expandIpv6(address: string): readonly number[] | undefined {
	const zoneless = address.split("%")[0] ?? address;
	// Embedded dotted-quad form, e.g. ::ffff:127.0.0.1
	const dotted = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(zoneless);
	let head = zoneless;
	let tailGroups: number[] = [];
	if (dotted !== null && dotted[2] !== undefined) {
		const octets = dotted[2].split(".").map(Number);
		if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
			return undefined;
		}
		const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = octets;
		head = `${dotted[1] ?? ""}:`;
		tailGroups = [(o0 << 8) | o1, (o2 << 8) | o3];
		head = head.endsWith("::") ? head : head.slice(0, -1);
	}
	const doubleColon = head.indexOf("::");
	const groupCount = 8 - tailGroups.length;
	let parts: string[];
	if (doubleColon >= 0) {
		const left = head.slice(0, doubleColon).split(":").filter(Boolean);
		const right = head
			.slice(doubleColon + 2)
			.split(":")
			.filter(Boolean);
		const missing = groupCount - left.length - right.length;
		if (missing < 0) return undefined;
		parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
	} else {
		parts = head.split(":").filter(Boolean);
	}
	if (parts.length !== groupCount) return undefined;
	const groups: number[] = [];
	for (const part of parts) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
		groups.push(Number.parseInt(part, 16));
	}
	return [...groups, ...tailGroups];
}
