import {
	StreamableHTTPClientTransport,
	applyMiddlewares,
	type AuthProvider,
	type FetchLike,
	type Middleware,
	type OAuthClientProvider,
	type StreamableHTTPClientTransportOptions,
	type Transport,
} from "@modelcontextprotocol/client";
import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { MaybePromise } from "@nest-mcp/core";

export interface McpHttpClientTransportDefinition {
	readonly kind: "http";
	readonly url: string | URL;
	/** Passed directly to the official Streamable HTTP transport. */
	readonly authProvider?: AuthProvider | OAuthClientProvider;
	/** Base fetch implementation wrapped by `middleware`, when supplied. */
	readonly fetch?: FetchLike;
	/** Official fetch middleware composed with `applyMiddlewares`. */
	readonly middleware?: readonly Middleware[];
	readonly requestInit?: RequestInit;
	readonly options?: Omit<
		StreamableHTTPClientTransportOptions,
		"authProvider" | "fetch" | "requestInit"
	>;
}

export interface McpStdioClientTransportDefinition {
	readonly kind: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly stderr?: StdioServerParameters["stderr"];
	readonly cwd?: string;
	readonly maxBufferSize?: number;
}

export type McpClientTransportDefinition =
	McpHttpClientTransportDefinition | McpStdioClientTransportDefinition;

export interface McpClientTransportFactoryContext {
	readonly serverName: string;
	readonly signal: AbortSignal;
}

/** Injectable seam for custom, in-memory, and test transports. */
export interface McpClientTransportFactory {
	createTransport(
		definition: McpClientTransportDefinition,
		context: McpClientTransportFactoryContext,
	): MaybePromise<Transport>;
}

/** Applies the official SDK's fetch-middleware composition semantics. */
export function composeMcpFetchMiddleware(
	middleware: readonly Middleware[],
	baseFetch: FetchLike = defaultFetch,
): FetchLike {
	return applyMiddlewares(...middleware)(baseFetch);
}

/** Creates the official MCP v2 Streamable HTTP client transport. */
export function createMcpHttpClientTransport(
	definition: McpHttpClientTransportDefinition,
): StreamableHTTPClientTransport {
	const url = normalizeHttpUrl(definition.url);
	const middleware = definition.middleware ?? [];
	validateMiddleware(middleware);

	const wrappedFetch =
		middleware.length === 0
			? definition.fetch
			: composeMcpFetchMiddleware(middleware, definition.fetch ?? defaultFetch);
	const options: StreamableHTTPClientTransportOptions = {
		...definition.options,
		...(definition.authProvider === undefined ? {} : { authProvider: definition.authProvider }),
		...(wrappedFetch === undefined ? {} : { fetch: wrappedFetch }),
		...(definition.requestInit === undefined ? {} : { requestInit: definition.requestInit }),
	};

	return new StreamableHTTPClientTransport(url, options);
}

/** Creates the official Node.js stdio transport. */
export function createMcpStdioClientTransport(
	definition: McpStdioClientTransportDefinition,
): StdioClientTransport {
	assertNonEmpty(definition.command, "stdio command");
	const parameters: StdioServerParameters = {
		command: definition.command,
		...(definition.args === undefined ? {} : { args: [...definition.args] }),
		...(definition.env === undefined ? {} : { env: { ...definition.env } }),
		...(definition.stderr === undefined ? {} : { stderr: definition.stderr }),
		...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
		...(definition.maxBufferSize === undefined ? {} : { maxBufferSize: definition.maxBufferSize }),
	};
	return new StdioClientTransport(parameters);
}

/** Creates one of the official transports from a discriminated definition. */
export function createMcpClientTransport(
	definition: McpClientTransportDefinition,
): StreamableHTTPClientTransport | StdioClientTransport {
	switch (definition.kind) {
		case "http":
			return createMcpHttpClientTransport(definition);
		case "stdio":
			return createMcpStdioClientTransport(definition);
		default:
			throw new TypeError("MCP client transport kind must be http or stdio.");
	}
}

/** Stateless transport factory used by runtimes that do not inject a custom factory. */
export const defaultMcpClientTransportFactory: McpClientTransportFactory = Object.freeze({
	createTransport(definition: McpClientTransportDefinition): Transport {
		return createMcpClientTransport(definition);
	},
});

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

function normalizeHttpUrl(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("MCP Streamable HTTP URLs must use http: or https:.");
	}
	return url;
}

function validateMiddleware(middleware: readonly Middleware[]): void {
	for (const [index, entry] of middleware.entries()) {
		if (typeof entry !== "function") {
			throw new TypeError(`HTTP middleware[${String(index)}] must be a function.`);
		}
	}
}

function assertNonEmpty(value: string, field: string): void {
	if (value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string.`);
}
