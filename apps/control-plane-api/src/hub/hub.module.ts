import { Module } from "@nestjs/common";
import { McpModule } from "@nest-mcp/nestjs";
import { allowAllMcpGatewayPolicy } from "@nest-mcp/gateway";

import { ConnectionStoreModule } from "../connections/connection-store.module.ts";
import { McpMetricsModule } from "../metrics/metrics.module.ts";
import { MCP_CONTROL_PLANE_METRICS_OBSERVER } from "../metrics/metrics.tokens.ts";
import { McpRuntimeModule } from "../runtime/mcp-runtime.module.ts";
import { HubMcpController } from "./hub-mcp.controller.ts";
import { HubController } from "./hub.controller.ts";
import { HubService } from "./hub.service.ts";
import {
	CONTROL_PLANE_HUB_SERVER_NAME,
	MCP_CONTROL_PLANE_HUB_OBSERVER,
	MCP_CONTROL_PLANE_HUB_POLICY,
} from "./hub.tokens.ts";

const hubMcpModule = McpModule.forRoot({
	imports: [McpMetricsModule],
	collaborators: {
		imports: [McpMetricsModule],
		providers: [
			{ provide: MCP_CONTROL_PLANE_HUB_POLICY, useValue: allowAllMcpGatewayPolicy() },
			{
				provide: MCP_CONTROL_PLANE_HUB_OBSERVER,
				useExisting: MCP_CONTROL_PLANE_METRICS_OBSERVER,
			},
		],
	},
	autoDiscover: false,
	servers: [
		{
			name: CONTROL_PLANE_HUB_SERVER_NAME,
			serverInfo: { name: "nest-mcp-control-plane-hub", version: "0.0.0" },
			lifecycleObserver: MCP_CONTROL_PLANE_HUB_OBSERVER,
			gateway: {
				dynamicUpstreams: true,
				upstreams: [],
				policy: MCP_CONTROL_PLANE_HUB_POLICY,
				lifecycleObserver: MCP_CONTROL_PLANE_HUB_OBSERVER,
			},
		},
	],
});

@Module({
	imports: [ConnectionStoreModule, McpRuntimeModule, McpMetricsModule, hubMcpModule],
	controllers: [HubController, HubMcpController],
	providers: [HubService],
	exports: [HubService],
})
export class HubModule {}
