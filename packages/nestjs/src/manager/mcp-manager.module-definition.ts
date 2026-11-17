import { ConfigurableModuleBuilder } from "@nestjs/common";

import { withMcpCollaborators } from "../mcp-provider.registry.ts";
import { MCP_MANAGER_MODULE_OPTIONS } from "../mcp.tokens.ts";
import type { McpManagerModuleExtras, McpManagerModuleOptions } from "./mcp-manager.types.ts";

export const {
	ConfigurableModuleClass: ConfigurableMcpManagerModuleClass,
	OPTIONS_TYPE: MCP_MANAGER_OPTIONS_TYPE,
	ASYNC_OPTIONS_TYPE: MCP_MANAGER_ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<McpManagerModuleOptions>({
	optionsInjectionToken: MCP_MANAGER_MODULE_OPTIONS,
})
	.setClassMethodName("forRoot")
	.setFactoryMethodName("createMcpManagerOptions")
	.setExtras<McpManagerModuleExtras>(
		{ isGlobal: false, collaborators: {} },
		(definition, extras) => ({
			...withMcpCollaborators(definition, extras.collaborators),
			global: extras.isGlobal === true,
		}),
	)
	.build();

export type McpManagerForRootOptions = typeof MCP_MANAGER_OPTIONS_TYPE;
export type McpManagerForRootAsyncOptions = typeof MCP_MANAGER_ASYNC_OPTIONS_TYPE;
