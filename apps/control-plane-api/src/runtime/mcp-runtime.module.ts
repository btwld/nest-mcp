import { Module } from "@nestjs/common";
import { McpManagerModule, McpManagerService } from "@nest-mcp/nestjs/manager";

import { ControlPlaneConfigModule } from "../config/control-plane-config.module.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { McpMetricsModule } from "../metrics/metrics.module.ts";
import { MCP_CONTROL_PLANE_METRICS_OBSERVER } from "../metrics/metrics.tokens.ts";
import { InMemoryRuntimeGenerationResolver } from "./runtime-generation.resolver.ts";
import { RuntimeGenerationModule } from "./runtime-generation.module.ts";
import { MCP_RUNTIME_SUPERVISOR } from "./runtime.types.ts";

const MCP_MANAGER_GENERATION_RESOLVER = Symbol(
	"example-mcp-control-plane:manager-generation-resolver",
);
const MCP_MANAGER_LIFECYCLE_OBSERVER = Symbol(
	"example-mcp-control-plane:manager-lifecycle-observer",
);

const managerModule = McpManagerModule.forRootAsync({
	imports: [ControlPlaneConfigModule],
	inject: [ControlPlaneConfigService],
	useFactory: (config: ControlPlaneConfigService) => ({
		generationResolver: MCP_MANAGER_GENERATION_RESOLVER,
		observer: MCP_MANAGER_LIFECYCLE_OBSERVER,
		maxConnections: config.maxConnections,
		requestTimeoutMs: config.requestTimeoutMs,
		shutdownTimeoutMs: config.shutdownTimeoutMs,
		maxDiscoveryPages: config.maxDiscoveryPages,
		maxDiscoveryItems: config.maxDiscoveryItems,
		clientInfo: { name: "nest-mcp-control-plane", version: "0.0.0" },
	}),
	collaborators: {
		imports: [RuntimeGenerationModule, McpMetricsModule],
		providers: [
			{
				provide: MCP_MANAGER_GENERATION_RESOLVER,
				useExisting: InMemoryRuntimeGenerationResolver,
			},
			{
				provide: MCP_MANAGER_LIFECYCLE_OBSERVER,
				useExisting: MCP_CONTROL_PLANE_METRICS_OBSERVER,
			},
		],
	},
});

@Module({
	imports: [ControlPlaneConfigModule, RuntimeGenerationModule, McpMetricsModule, managerModule],
	providers: [{ provide: MCP_RUNTIME_SUPERVISOR, useExisting: McpManagerService }],
	exports: [RuntimeGenerationModule, MCP_RUNTIME_SUPERVISOR],
})
export class McpRuntimeModule {}
