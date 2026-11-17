import { ConfigurableModuleBuilder } from "@nestjs/common";
import { withMcpCollaborators } from "../mcp-provider.registry.ts";
import { MCP_CLIENT_MODULE_OPTIONS } from "../mcp.tokens.ts";
import type { McpClientModuleExtras, McpClientModuleOptions } from "./mcp-client.types.ts";

export const {
	ConfigurableModuleClass: ConfigurableMcpClientModuleClass,
	OPTIONS_TYPE: MCP_CLIENT_OPTIONS_TYPE,
	ASYNC_OPTIONS_TYPE: MCP_CLIENT_ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<McpClientModuleOptions>({
	optionsInjectionToken: MCP_CLIENT_MODULE_OPTIONS,
})
	.setClassMethodName("forRoot")
	.setFactoryMethodName("createMcpClientOptions")
	.setExtras<McpClientModuleExtras>(
		{ isGlobal: false, collaborators: {} },
		(definition, extras) => ({
			...withMcpCollaborators(definition, extras.collaborators),
			global: extras.isGlobal === true,
		}),
	)
	.build();

export type McpClientForRootOptions = typeof MCP_CLIENT_OPTIONS_TYPE;
export type McpClientForRootAsyncOptions = typeof MCP_CLIENT_ASYNC_OPTIONS_TYPE;
