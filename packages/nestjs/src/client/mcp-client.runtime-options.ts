import type {
	AuthProvider,
	ClientOptions,
	ConnectOptions,
	OAuthClientProvider,
	StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import type {
	McpClientRuntimeOptions,
	McpClientServerDefinition,
	McpClientTransportDefinition,
} from "@nest-mcp/client";
import { bindMcpClientMiddleware } from "@nest-mcp/client";
import type { McpLifecycleMiddlewareOptions } from "@nest-mcp/core";
import { McpModuleError } from "../mcp.errors.ts";
import { McpProviderRegistry, mcpProviderTokenName } from "../mcp-provider.registry.ts";
import type { McpProviderToken } from "../mcp-provider.types.ts";
import type {
	McpClientModuleOptions,
	McpClientMiddlewareProvider,
	McpNestClientConnectOptions,
	McpNestClientDefinition,
	McpNestClientOptions,
	McpNestClientRuntimeOptions,
	McpNestClientTransportDefinition,
} from "./mcp-client.types.ts";

export function resolveMcpClientRuntimeOptions(
	options: McpClientModuleOptions,
	providers: McpProviderRegistry,
): McpClientRuntimeOptions {
	const runtime = options.runtime ?? {};
	const {
		attributesResolver,
		clientFactory,
		clock,
		lifecycle,
		middleware,
		observer,
		operationIdFactory,
		principalResolver,
		transportFactory,
		...data
	} = runtime;
	discardProperties(data, ["now", "principal", "resolveAttributes", "resolvePrincipal", "servers"]);
	return {
		...data,
		servers: (options.servers ?? []).map((definition) =>
			resolveServerDefinition(definition, providers),
		),
		...(clientFactory === undefined
			? {}
			: { clientFactory: requireMethodProvider(providers, clientFactory, "createClient") }),
		...(transportFactory === undefined
			? {}
			: {
					transportFactory: requireMethodProvider(providers, transportFactory, "createTransport"),
				}),
		...(middleware === undefined
			? {}
			: {
					middleware: middleware.map((token) => bindClientMiddlewareProvider(providers, token)),
				}),
		...(observer === undefined
			? {}
			: { observer: requireMethodProvider(providers, observer, "onEvent") }),
		...(lifecycle === undefined
			? {}
			: { lifecycle: resolveLifecycleOptions(lifecycle, providers) }),
		...(principalResolver === undefined
			? {}
			: {
					resolvePrincipal: bindProviderMethod(providers, principalResolver, "resolvePrincipal"),
				}),
		...(attributesResolver === undefined
			? {}
			: {
					resolveAttributes: bindProviderMethod(providers, attributesResolver, "resolveAttributes"),
				}),
		...(operationIdFactory === undefined
			? {}
			: {
					operationIdFactory: bindProviderMethod(
						providers,
						operationIdFactory,
						"createOperationId",
					),
				}),
		...(clock === undefined ? {} : { now: bindProviderMethod(providers, clock, "now") }),
	};
}

function resolveServerDefinition(
	definition: McpNestClientDefinition,
	providers: McpProviderRegistry,
): McpClientServerDefinition {
	const { clientOptions, configureClient, connectOptions, transport, transportFactory, ...data } =
		definition;
	return {
		...data,
		transport: resolveTransportDefinition(transport, providers),
		...(clientOptions === undefined
			? {}
			: { clientOptions: resolveClientOptions(clientOptions, providers) }),
		...(connectOptions === undefined
			? {}
			: { connectOptions: resolveConnectOptions(connectOptions, providers) }),
		...(configureClient === undefined
			? {}
			: {
					configureClient: bindProviderMethod(providers, configureClient, "configure"),
				}),
		...(transportFactory === undefined
			? {}
			: {
					transportFactory: requireMethodProvider(providers, transportFactory, "createTransport"),
				}),
	};
}

function resolveClientOptions(
	options: McpNestClientOptions,
	providers: McpProviderRegistry,
): ClientOptions {
	const { jsonSchemaValidator, responseCacheStore, ...data } = options;
	discardProperties(data, ["listChanged"]);
	return {
		...data,
		...(jsonSchemaValidator === undefined
			? {}
			: {
					jsonSchemaValidator: requireMethodProvider(
						providers,
						jsonSchemaValidator,
						"getValidator",
					),
				}),
		...(responseCacheStore === undefined
			? {}
			: {
					responseCacheStore: requireMethodProvider(providers, responseCacheStore, [
						"get",
						"set",
						"delete",
						"evict",
						"clear",
					]),
				}),
	};
}

function resolveConnectOptions(
	options: McpNestClientConnectOptions,
	providers: McpProviderRegistry,
): ConnectOptions {
	const { progressObserver, ...data } = options;
	discardProperties(data, ["onprogress", "signal"]);
	return {
		...data,
		...(progressObserver === undefined
			? {}
			: { onprogress: bindProviderMethod(providers, progressObserver, "onProgress") }),
	};
}

function resolveTransportDefinition(
	definition: McpNestClientTransportDefinition,
	providers: McpProviderRegistry,
): McpClientTransportDefinition {
	if (definition.kind === "stdio") {
		const { stderrStream, ...data } = definition;
		if (stderrStream !== undefined && definition.stderr !== undefined) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				"An MCP stdio client transport cannot configure both stderr and stderrStream.",
			);
		}
		if (
			definition.stderr !== undefined &&
			typeof definition.stderr !== "string" &&
			typeof definition.stderr !== "number"
		) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				"An MCP stdio client transport must reference live stderr streams through stderrStream.",
			);
		}
		return {
			...data,
			...(stderrStream === undefined
				? {}
				: { stderr: requireMethodProvider(providers, stderrStream, ["on", "pipe"]) }),
		};
	}
	const { authProvider, fetch, middleware, options, requestInit, ...data } = definition;
	return {
		...data,
		kind: "http",
		...(authProvider === undefined
			? {}
			: { authProvider: requireAuthProvider(providers, authProvider) }),
		...(fetch === undefined ? {} : { fetch: bindProviderMethod(providers, fetch, "fetch") }),
		...(middleware === undefined
			? {}
			: {
					middleware: middleware.map((token) => bindProviderMethod(providers, token, "handle")),
				}),
		...(requestInit === undefined ? {} : { requestInit: requireProvider(providers, requestInit) }),
		...(options === undefined ? {} : { options: resolveHttpTransportOptions(options, providers) }),
	};
}

function resolveHttpTransportOptions(
	options: NonNullable<Extract<McpNestClientTransportDefinition, { kind: "http" }>["options"]>,
	providers: McpProviderRegistry,
): Omit<StreamableHTTPClientTransportOptions, "authProvider" | "fetch" | "requestInit"> {
	const { reconnectionScheduler, ...data } = options;
	discardProperties(data, ["authProvider", "fetch", "requestInit"]);
	return {
		...data,
		...(reconnectionScheduler === undefined
			? {}
			: {
					reconnectionScheduler: bindProviderMethod(providers, reconnectionScheduler, "schedule"),
				}),
	};
}

function resolveLifecycleOptions(
	options: NonNullable<McpNestClientRuntimeOptions["lifecycle"]>,
	providers: McpProviderRegistry,
): McpLifecycleMiddlewareOptions {
	return {
		...(options.clock === undefined
			? {}
			: { now: bindProviderMethod(providers, options.clock, "now") }),
		...(options.errorReporter === undefined
			? {}
			: {
					onObserverError: bindProviderMethod(providers, options.errorReporter, "report"),
				}),
	};
}

function requireProvider<Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
): Value {
	const provider = providers.get(token);
	if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
		throw missingProviderError(token);
	}
	// Token typing and Nest's provider registration establish the public contract.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider as Value;
}

function requireMethodProvider<Value extends object, Method extends keyof Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
	methods: Method | readonly Method[],
): Value & Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>> {
	const provider = requireProvider(providers, token);
	const requiredMethods = Array.isArray(methods) ? methods : [methods];
	if (requiredMethods.some((method) => typeof Reflect.get(provider, method) !== "function")) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP client collaborator ${mcpProviderTokenName(token)} must implement ${requiredMethods
				.map((method) => `${String(method)}()`)
				.join(", ")}.`,
		);
	}
	// Runtime validation above narrows the configured method to a callable.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider as Value &
		Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>>;
}

function requireAuthProvider(
	providers: McpProviderRegistry,
	token: McpProviderToken<AuthProvider | OAuthClientProvider>,
): AuthProvider | OAuthClientProvider {
	const provider = requireProvider(providers, token);
	if (typeof Reflect.get(provider, "token") === "function") {
		return provider;
	}
	const requiredOAuthMethods = [
		"clientInformation",
		"tokens",
		"saveTokens",
		"redirectToAuthorization",
		"saveCodeVerifier",
		"codeVerifier",
	] as const;
	if (
		requiredOAuthMethods.some((method) => typeof Reflect.get(provider, method) !== "function") ||
		!("clientMetadata" in provider) ||
		!("redirectUrl" in provider)
	) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP client collaborator ${mcpProviderTokenName(token)} must implement AuthProvider.token() or the OAuthClientProvider contract.`,
		);
	}
	return provider;
}

function bindProviderMethod<Value extends object, Method extends keyof Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
	method: Method,
): Extract<Value[Method], (...arguments_: never[]) => unknown> {
	const provider = requireMethodProvider(providers, token, method);
	// Function.bind() loses the indexed-access relationship; the validated method keeps it.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider[method].bind(provider) as Extract<
		Value[Method],
		(...arguments_: never[]) => unknown
	>;
}

function bindClientMiddlewareProvider(
	providers: McpProviderRegistry,
	token: McpProviderToken<McpClientMiddlewareProvider>,
) {
	const provider = requireMethodProvider(providers, token, "handle");
	return bindMcpClientMiddleware(provider.handle, provider);
}

function missingProviderError(token: unknown): McpModuleError {
	return new McpModuleError(
		"INVALID_OPTIONS",
		`MCP client collaborator ${mcpProviderTokenName(token)} must be listed in McpClientModule collaborators.providers.`,
	);
}

function discardProperties(value: object, properties: readonly PropertyKey[]): void {
	for (const property of properties) Reflect.deleteProperty(value, property);
}
