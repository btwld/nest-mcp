import { McpModuleError } from "../mcp.errors.ts";
import { mcpProviderTokenName } from "../mcp-provider.registry.ts";
import type { McpProviderRegistry } from "../mcp-provider.registry.ts";
import type { McpProviderToken } from "../mcp-provider.types.ts";

export function requireProvider<Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
): Value {
	const provider = providers.get(token);
	if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server collaborator ${mcpProviderTokenName(token)} must be listed in McpModule collaborators.providers.`,
		);
	}
	// Token typing and Nest's provider registration establish the public contract.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider as Value;
}

export function requireMethodProvider<Value extends object, Method extends keyof Value>(
	providers: McpProviderRegistry,
	token: McpProviderToken<Value>,
	methods: Method | readonly Method[],
): Value & Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>> {
	const provider = requireProvider(providers, token);
	const requiredMethods = Array.isArray(methods) ? methods : [methods];
	if (requiredMethods.some((method) => typeof Reflect.get(provider, method) !== "function")) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			`MCP server collaborator ${mcpProviderTokenName(token)} must implement ${requiredMethods
				.map((method) => `${String(method)}()`)
				.join(", ")}.`,
		);
	}
	// Runtime validation above narrows the configured method to a callable.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return provider as Value &
		Record<Method, Extract<Value[Method], (...arguments_: never[]) => unknown>>;
}

export function bindProviderMethod<Value extends object, Method extends keyof Value>(
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

export function discardProperties(value: object, properties: readonly PropertyKey[]): void {
	for (const property of properties) Reflect.deleteProperty(value, property);
}
