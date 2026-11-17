import { jsonResponse, oauthErrorResponse } from "./proxy/http.ts";
import type { McpOAuthProxy } from "./proxy/mcp-oauth-proxy.ts";

export interface McpOAuthRouterOptions {
	readonly proxy: McpOAuthProxy;
	/** Route prefix for the `/oauth/*` endpoints (well-known paths stay at root). */
	readonly basePath?: string;
	/** Max form-body bytes read from the token/consent endpoints. */
	readonly maxBodyBytes?: number;
}

/**
 * Dispatches OAuth authorization-server requests. Returns `undefined` when the
 * request is not one of the proxy's routes, so it composes like the other
 * fetch-handler facades. `parsedBody` accepts a platform-parsed form body so
 * Fastify/Express hosts need no extra body parser for `/oauth/token`.
 */
export type McpOAuthRouter = (
	request: Request,
	options?: { readonly parsedBody?: unknown },
) => Promise<Response | undefined>;

const DEFAULT_MAX_BODY_BYTES = 65_536;

export function createMcpOAuthRouter(options: McpOAuthRouterOptions): McpOAuthRouter {
	const proxy = options.proxy;
	const base = normalizeBasePath(options.basePath);
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const route = (path: string): string => `${base}${path}`;

	return async (request, dispatch) => {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();

		if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
			return jsonResponse(200, proxy.authorizationServerMetadata);
		}
		if (method === "GET" && path === "/.well-known/jwks.json") {
			return jsonResponse(200, proxy.jwks());
		}
		// RFC 9728 protected-resource metadata, including the path-aware suffix.
		if (
			method === "GET" &&
			(path === "/.well-known/oauth-protected-resource" ||
				path.startsWith("/.well-known/oauth-protected-resource/"))
		) {
			try {
				return jsonResponse(200, proxy.protectedResourceMetadata());
			} catch {
				return undefined;
			}
		}
		if (path === route("/oauth/authorize")) {
			if (method !== "GET") return methodNotAllowed();
			return proxy.authorize(request);
		}
		if (path === route("/oauth/authorize/consent")) {
			if (method !== "POST") return methodNotAllowed();
			return proxy.handleConsent(
				request,
				await readForm(request, dispatch?.parsedBody, maxBodyBytes),
			);
		}
		if (path === route("/oauth/callback")) {
			if (method !== "GET") return methodNotAllowed();
			return proxy.handleCallback(request);
		}
		if (path === route("/oauth/token")) {
			if (method !== "POST") return methodNotAllowed();
			return proxy.token(request, await readForm(request, dispatch?.parsedBody, maxBodyBytes));
		}
		return undefined;
	};
}

async function readForm(
	request: Request,
	parsedBody: unknown,
	maxBodyBytes: number,
): Promise<URLSearchParams> {
	if (parsedBody !== undefined) return toSearchParams(parsedBody);
	const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes)
		return new URLSearchParams();
	const text = await readCappedText(request, maxBodyBytes);
	return new URLSearchParams(text);
}

function toSearchParams(parsedBody: unknown): URLSearchParams {
	if (parsedBody instanceof URLSearchParams) return parsedBody;
	if (typeof parsedBody === "string") return new URLSearchParams(parsedBody);
	if (typeof parsedBody === "object" && parsedBody !== null) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(parsedBody)) {
			if (typeof value === "string") params.set(key, value);
			else if (Array.isArray(value))
				for (const entry of value) if (typeof entry === "string") params.append(key, entry);
		}
		return params;
	}
	return new URLSearchParams();
}

async function readCappedText(request: Request, maxBodyBytes: number): Promise<string> {
	if (request.body === null) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBodyBytes) {
				await reader.cancel();
				return "";
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

function methodNotAllowed(): Response {
	return oauthErrorResponse(405, "method_not_allowed", "Method not allowed for this endpoint.");
}

function normalizeBasePath(basePath: string | undefined): string {
	if (basePath === undefined || basePath === "" || basePath === "/") return "";
	const trimmed = basePath.startsWith("/") ? basePath : `/${basePath}`;
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
