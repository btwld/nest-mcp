import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { McpServerRegistry } from "@nest-mcp/server";
import {
	ConfigurableModuleClass,
	type McpForRootAsyncOptions,
	type McpForRootOptions,
} from "./mcp.module-definition.ts";
import { McpCapabilitiesService } from "./mcp-capabilities.service.ts";
import { McpRuntimeService } from "./mcp-runtime.service.ts";
import { McpOAuthService } from "./oauth/mcp-oauth.service.ts";
import { McpHandlerExplorer } from "./discovery/mcp-handler.explorer.ts";
import { McpHandlerRegistry } from "./discovery/mcp-handler.registry.ts";

const MCP_PROVIDERS = [
	McpServerRegistry,
	McpHandlerRegistry,
	McpCapabilitiesService,
	McpHandlerExplorer,
	McpRuntimeService,
	McpOAuthService,
];

@Module({
	imports: [DiscoveryModule],
	providers: MCP_PROVIDERS,
	exports: [McpCapabilitiesService, McpRuntimeService, McpOAuthService],
})
export class McpModule extends ConfigurableModuleClass {
	static override forRoot(options: McpForRootOptions = {}): DynamicModule {
		return super.forRoot(options);
	}

	static override forRootAsync(options: McpForRootAsyncOptions): DynamicModule {
		return super.forRootAsync(options);
	}
}
