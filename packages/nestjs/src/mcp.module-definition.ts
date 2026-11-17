import { ConfigurableModuleBuilder } from "@nestjs/common";
import { withMcpCollaborators } from "./mcp-provider.registry.ts";
import { MCP_MODULE_OPTIONS } from "./mcp.tokens.ts";
import type { McpModuleExtras, McpModuleOptions } from "./mcp.types.ts";
import { withMcpHttpRoutes } from "./http/mcp-http-routes.ts";

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
	new ConfigurableModuleBuilder<McpModuleOptions>({
		optionsInjectionToken: MCP_MODULE_OPTIONS,
	})
		.setClassMethodName("forRoot")
		.setFactoryMethodName("createMcpOptions")
		.setExtras<McpModuleExtras>(
			{ isGlobal: false, imports: [], collaborators: {}, httpRoutes: [] },
			(definition, extras) => ({
				...withMcpHttpRoutes(
					withMcpCollaborators(
						{
							...definition,
							imports: [...new Set([...(definition.imports ?? []), ...(extras.imports ?? [])])],
						},
						extras.collaborators,
					),
					extras.httpRoutes,
				),
				global: extras.isGlobal === true,
			}),
		)
		.build();

export type McpForRootOptions = typeof OPTIONS_TYPE;
export type McpForRootAsyncOptions = typeof ASYNC_OPTIONS_TYPE;
