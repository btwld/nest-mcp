import type { CreateMcpHandlerOptions, ServerOptions } from "@modelcontextprotocol/server";
import { McpProviderRegistry } from "../mcp-provider.registry.ts";
import {
	bindProviderMethod,
	discardProperties,
	requireMethodProvider,
} from "./provider-resolution.ts";
import type { McpNestServerHttpOptions, McpNestServerOptions } from "./mcp-server.types.ts";

export function resolveMcpNestServerOptions(
	options: McpNestServerOptions | undefined,
	providers: McpProviderRegistry,
): ServerOptions | undefined {
	if (options === undefined) return undefined;
	const { jsonSchemaValidator, requestState, ...data } = options;
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
		...(requestState === undefined
			? {}
			: {
					requestState:
						requestState.verifier === undefined
							? {}
							: {
									verify: bindProviderMethod(providers, requestState.verifier, "verify"),
								},
				}),
	};
}

export function resolveMcpNestServerHttpOptions(
	options: McpNestServerHttpOptions | undefined,
	providers: McpProviderRegistry,
): Omit<CreateMcpHandlerOptions, "onerror"> | undefined {
	if (options === undefined) return undefined;
	const { eventBus, ...data } = options;
	discardProperties(data, ["bus", "onerror"]);
	return {
		...data,
		...(eventBus === undefined
			? {}
			: {
					bus: requireMethodProvider(providers, eventBus, ["publish", "subscribe"]),
				}),
	};
}
