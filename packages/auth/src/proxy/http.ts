import { OAuthErrorCode } from "@modelcontextprotocol/server";

/** A resolved client from CIMD or the registered-client store. */
export interface McpOAuthClient {
	readonly clientId: string;
	readonly clientName: string;
	readonly redirectUris: readonly string[];
	readonly tokenEndpointAuthMethod:
		"none" | "client_secret_basic" | "client_secret_post" | "private_key_jwt";
	readonly clientSecretHash?: string;
	readonly loopbackOnly: boolean;
	readonly source: "cimd" | "registered";
}

/** Resolves preconfigured or dynamically-registered (non-CIMD) clients. */
export interface McpOAuthClientResolver {
	resolveClient(
		clientId: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<McpOAuthClient | undefined>;
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}

/** OAuth error JSON response (RFC 6749 §5.2), always with a fixed description. */
export function oauthErrorResponse(
	status: number,
	error: OAuthErrorCode | string,
	description: string,
	headers?: Record<string, string>,
): Response {
	return jsonResponse(status, { error, error_description: description }, headers);
}

/** Rendered (non-redirect) error page for pre-redirect-validation failures. */
export function renderErrorResponse(status: number, error: string, description: string): Response {
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><h1>Authorization error</h1><p><code>${escapeHtml(error)}</code></p><p>${escapeHtml(description)}</p></body></html>`;
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
		},
	});
}

/** 302 back to a validated redirect URI carrying an OAuth error (+ state, + iss). */
export function redirectErrorResponse(
	redirectUri: string,
	error: string,
	options: { readonly state?: string; readonly iss: string; readonly description?: string },
): Response {
	const target = new URL(redirectUri);
	target.searchParams.set("error", error);
	if (options.description !== undefined)
		target.searchParams.set("error_description", options.description);
	if (options.state !== undefined) target.searchParams.set("state", options.state);
	target.searchParams.set("iss", options.iss);
	return redirectResponse(target.href);
}

/** A 302 redirect that also carries `Cache-Control: no-store`. */
export function redirectResponse(location: string, headers?: Record<string, string>): Response {
	return new Response(null, {
		status: 302,
		headers: { location, "cache-control": "no-store", ...headers },
	});
}

export interface CookieOptions {
	readonly maxAgeSeconds?: number;
	readonly sameSite?: "Lax" | "Strict" | "None";
}

/** Serializes a `__Host-`-prefixed cookie (Secure, HttpOnly, Path=/). */
export function setCookieHeader(name: string, value: string, options?: CookieOptions): string {
	const parts = [
		`${name}=${value}`,
		"Path=/",
		"Secure",
		"HttpOnly",
		`SameSite=${options?.sameSite ?? "Lax"}`,
	];
	if (options?.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`);
	return parts.join("; ");
}

export function withSetCookie(response: Response, cookie: string): Response {
	const headers = new Headers(response.headers);
	headers.append("set-cookie", cookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get("cookie");
	if (header === null) return {};
	const cookies: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		const name = pair.slice(0, index).trim();
		cookies[name] = pair.slice(index + 1).trim();
	}
	return cookies;
}

/**
 * True only when the request is provably same-origin, failing closed otherwise
 * (consent CSRF). An `Origin: null` (opaque origin, e.g. a sandboxed iframe or a
 * cross-site redirect) is rejected, not treated as absent, and a request that
 * carries neither `Origin` nor `Referer` is accepted only if `Sec-Fetch-Site`
 * positively asserts same-origin — a missing value is not sufficient.
 */
export function isSameOriginRequest(request: Request): boolean {
	const target = new URL(request.url).origin;
	const origin = request.headers.get("origin");
	if (origin !== null) return origin === target; // `null` origin ⇒ reject
	const referer = request.headers.get("referer");
	if (referer !== null) {
		try {
			return new URL(referer).origin === target;
		} catch {
			return false;
		}
	}
	// No Origin and no Referer: require a positive same-origin fetch-metadata signal.
	return request.headers.get("sec-fetch-site") === "same-origin";
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) =>
		char === "&"
			? "&amp;"
			: char === "<"
				? "&lt;"
				: char === ">"
					? "&gt;"
					: char === '"'
						? "&quot;"
						: "&#39;",
	);
}
