import type { NodeIncomingMessageLike, NodeServerResponseLike } from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";

/**
 * Platform-neutral bridge between Nest's Express/Fastify request objects and
 * the official Node MCP adapter. Shared by every Nest controller that hands a
 * raw exchange to a fetch-shaped MCP facade.
 */

interface RawCarrier {
	readonly raw: unknown;
}

interface BodyCarrier {
	readonly body: unknown;
}

interface FastifyReplyLike extends RawCarrier {
	hijack(): unknown;
}

export function toNodeRequest(request: unknown): NodeIncomingMessageLike {
	const candidate = hasRaw(request) ? request.raw : request;
	if (!isNodeRequest(candidate)) {
		throw new TypeError("Nest MCP HTTP controller requires a Node-compatible HTTP request.");
	}
	return candidate;
}

export function toNodeResponse(response: unknown): NodeServerResponseLike {
	const candidate = hasRaw(response) ? response.raw : response;
	if (!isNodeResponse(candidate)) {
		throw new TypeError("Nest MCP HTTP controller requires a Node-compatible HTTP response.");
	}
	return candidate;
}

export function parsedBodyOf(request: unknown): unknown {
	return hasBody(request) ? request.body : undefined;
}

export function hijackFastifyReply(response: unknown, rawResponse: NodeServerResponseLike): void {
	if (!isFastifyReply(response) || response.raw !== rawResponse) return;
	response.hijack();
}

export function forwardValidatedAuth(request: unknown, rawRequest: NodeIncomingMessageLike): void {
	if (request === rawRequest || !isObject(request) || rawRequest.auth !== undefined) return;
	const auth = Reflect.get(request, "auth");
	if (isAuthInfo(auth)) rawRequest.auth = auth;
}

function isAuthInfo(value: unknown): value is AuthInfo {
	if (!isObject(value)) return false;
	const token = Reflect.get(value, "token");
	const clientId = Reflect.get(value, "clientId");
	const scopes = Reflect.get(value, "scopes");
	const expiresAt = Reflect.get(value, "expiresAt");
	const resource = Reflect.get(value, "resource");
	const extra = Reflect.get(value, "extra");
	return (
		typeof token === "string" &&
		typeof clientId === "string" &&
		Array.isArray(scopes) &&
		scopes.every((scope) => typeof scope === "string") &&
		(expiresAt === undefined || typeof expiresAt === "number") &&
		(resource === undefined || resource instanceof URL) &&
		(extra === undefined || isObject(extra))
	);
}

function hasRaw(value: unknown): value is RawCarrier {
	return isObject(value) && "raw" in value;
}

function hasBody(value: unknown): value is BodyCarrier {
	return isObject(value) && "body" in value;
}

function isFastifyReply(value: unknown): value is FastifyReplyLike {
	return hasRaw(value) && typeof Reflect.get(value, "hijack") === "function";
}

function isNodeRequest(value: unknown): value is NodeIncomingMessageLike {
	return (
		isObject(value) &&
		isObject(Reflect.get(value, "headers")) &&
		typeof Reflect.get(value, Symbol.asyncIterator) === "function"
	);
}

function isNodeResponse(value: unknown): value is NodeServerResponseLike {
	return (
		isObject(value) &&
		typeof Reflect.get(value, "writeHead") === "function" &&
		typeof Reflect.get(value, "write") === "function" &&
		typeof Reflect.get(value, "end") === "function" &&
		typeof Reflect.get(value, "on") === "function"
	);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/** Reconstructs the request origin, honoring a terminating proxy's forwarded headers. */
export function nodeRequestUrl(request: unknown): URL {
	const raw = toNodeRequest(request);
	const headers = raw.headers;
	const forwardedProto = headerValue(headers["x-forwarded-proto"]);
	const encrypted = Reflect.get(Reflect.get(raw, "socket") ?? {}, "encrypted") === true;
	const scheme = forwardedProto ?? (encrypted ? "https" : "http");
	const host = headerValue(headers["x-forwarded-host"]) ?? headerValue(headers.host) ?? "localhost";
	return new URL(raw.url ?? "/", `${scheme}://${host}`);
}

/** Builds a web `Request` from a Nest request with an explicit body, for hand dispatch. */
export function toWebRequestWithBody(request: unknown, body: string | undefined): Request {
	const raw = toNodeRequest(request);
	const url = nodeRequestUrl(request);
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw.headers)) {
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) headers.set(name, value.join(", "));
	}
	const method = (raw.method ?? "GET").toUpperCase();
	const carriesBody = method !== "GET" && method !== "HEAD" && body !== undefined;
	return new Request(url.href, {
		method,
		headers,
		...(carriesBody ? { body } : {}),
	});
}

/** Reads a Node request body as text, capped; returns "" when the stream is empty or over cap. */
export async function readNodeBodyText(request: unknown, maxBytes: number): Promise<string> {
	const raw = toNodeRequest(request);
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of raw as AsyncIterable<unknown>) {
		const buffer =
			typeof chunk === "string"
				? Buffer.from(chunk)
				: chunk instanceof Uint8Array
					? Buffer.from(chunk)
					: undefined;
		if (buffer === undefined) continue;
		total += buffer.byteLength;
		if (total > maxBytes) return "";
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Writes a web `Response` (status, headers, multiple set-cookie, buffered body) to a Node response. */
export async function writeWebResponse(response: Response, nestResponse: unknown): Promise<void> {
	const raw = toNodeResponse(nestResponse);
	hijackFastifyReply(nestResponse, raw);
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		if (key.toLowerCase() !== "set-cookie") headers[key] = value;
	});
	const cookies =
		typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	if (cookies.length > 0) headers["set-cookie"] = cookies;
	// Node's writeHead accepts array header values (e.g. multiple Set-Cookie),
	// which the structural NodeServerResponseLike type narrows to string.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	raw.writeHead(response.status, headers as Record<string, string>);
	const body = response.body === null ? undefined : Buffer.from(await response.arrayBuffer());
	raw.end(body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
