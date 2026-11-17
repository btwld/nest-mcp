import type { NodeIncomingMessageLike, NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { corsAllowedOrigin, isMcpHttpSecurityPolicy } from "./mcp-http-security.ts";
import type { McpHardenHooks, McpHttpSecurityPolicy } from "./mcp-http-security.ts";

export type McpNodeBodyLimit = number | McpHttpSecurityPolicy | undefined;

/**
 * Caps the raw Node request body before the SDK's `toWebRequest` buffers it
 * unbounded. Skips requests the platform already parsed and bodyless methods.
 * On overflow it answers `413` (with CORS headers when a policy is supplied)
 * and never invokes the wrapped handler; on success the buffered bytes are
 * replayed through the request's own async iterator so `req.auth` and other
 * platform decorations survive.
 *
 * Stream errors during the read (e.g. a peer aborting mid-upload) are captured
 * and re-thrown from the replay iterator, so the wrapped SDK adapter keeps
 * ownership of them through its own `try/catch → onerror → 500` path rather
 * than rejecting the returned promise (which would be an unhandled rejection
 * on fire-and-forget mounts).
 */
export function withMcpNodeBodyLimit(
	handler: NodeMcpRequestHandler,
	limit: McpNodeBodyLimit,
	hooks?: McpHardenHooks,
): NodeMcpRequestHandler {
	const policy = isMcpHttpSecurityPolicy(limit) ? limit : undefined;
	const maxBodyBytes: number | undefined = isMcpHttpSecurityPolicy(limit)
		? limit.maxBodyBytes
		: limit;
	if (maxBodyBytes === undefined) return handler;
	return async (req, res, parsedBody) => {
		// Express/Connect invoke mounted handlers as (req, res, next); a function
		// third argument is Express's `next`, never a body — the SDK drops it too.
		const body = typeof parsedBody === "function" ? undefined : parsedBody;
		if (body !== undefined || !methodMayCarryBody(req.method)) {
			return handler(req, res, parsedBody);
		}
		const declaredLength = declaredContentLength(req);
		if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
			rejectOversize(req, res, maxBodyBytes, policy, hooks);
			return;
		}
		const chunks: (string | Uint8Array)[] = [];
		let total = 0;
		let readError: unknown;
		try {
			for await (const chunk of req) {
				if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) continue;
				total += byteLengthOf(chunk);
				if (total > maxBodyBytes) {
					rejectOversize(req, res, maxBodyBytes, policy, hooks);
					return;
				}
				chunks.push(chunk);
			}
		} catch (cause) {
			// Peer aborted mid-body / stream error. Hand it back to the adapter
			// via the replay iterator instead of rejecting this promise.
			readError = cause;
		}
		// Replay on the original request object rather than a clone: toWebRequest
		// reads headers/method/auth from this exact object.
		Object.defineProperty(req, Symbol.asyncIterator, {
			configurable: true,
			writable: true,
			value: async function* replayBufferedBody(): AsyncGenerator<string | Uint8Array> {
				yield* chunks;
				if (readError !== undefined) throw readError;
			},
		});
		return handler(req, res, undefined);
	};
}

function methodMayCarryBody(method: string | undefined): boolean {
	const normalized = (method ?? "GET").toUpperCase();
	return normalized !== "GET" && normalized !== "HEAD";
}

function declaredContentLength(req: NodeIncomingMessageLike): number | undefined {
	const header = req.headers["content-length"];
	const value = Array.isArray(header) ? header[0] : header;
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function byteLengthOf(chunk: unknown): number {
	if (typeof chunk === "string") return Buffer.byteLength(chunk);
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	return 0;
}

function rejectOversize(
	req: NodeIncomingMessageLike,
	res: {
		writeHead(statusCode: number, headers?: Record<string, string>): unknown;
		end(chunk?: string | Uint8Array): unknown;
		destroyed?: boolean;
	},
	maxBodyBytes: number,
	policy: McpHttpSecurityPolicy | undefined,
	hooks: McpHardenHooks | undefined,
): void {
	// Drain what the peer already sent so the 413 can flush, then half-close.
	const resume = Reflect.get(req, "resume");
	if (typeof resume === "function") Reflect.apply(resume, req, []);
	if (hooks?.onRejected !== undefined) {
		try {
			hooks.onRejected(413);
		} catch {
			// Observation never changes the response.
		}
	}
	if (res.destroyed === true) return;
	res.writeHead(413, {
		"content-type": "application/json",
		connection: "close",
		...corsHeadersFor(req, policy),
	});
	res.end(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32600,
				message: `Request body exceeds the ${String(maxBodyBytes)}-byte limit.`,
			},
			id: null,
		}),
	);
}

function corsHeadersFor(
	req: NodeIncomingMessageLike,
	policy: McpHttpSecurityPolicy | undefined,
): Record<string, string> {
	if (policy?.cors === undefined) return {};
	const origin = originHeader(req);
	if (origin === undefined) return {};
	// Reuse the same origin decision the fetch layer applies.
	const allowed = corsAllowedOrigin(
		new Request("http://body-limit.invalid", { headers: { origin } }),
		policy,
	);
	if (allowed === undefined) return {};
	const headers: Record<string, string> = {
		"access-control-allow-origin": allowed,
		"access-control-expose-headers": policy.cors.exposedHeaders,
		vary: "Origin",
	};
	if (policy.cors.credentials) headers["access-control-allow-credentials"] = "true";
	return headers;
}

function originHeader(req: NodeIncomingMessageLike): string | undefined {
	const header = req.headers["origin"];
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
