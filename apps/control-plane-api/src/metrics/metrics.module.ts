import { Module } from "@nestjs/common";
import {
	McpFixedMemoryMetricsCollector,
	createMcpMetricsObserver,
	type McpMetricsSink,
} from "@nest-mcp/observability";

import { McpMetricsController, PrometheusMetricsController } from "./metrics.controller.ts";
import { MCP_CONTROL_PLANE_METRICS_OBSERVER } from "./metrics.tokens.ts";

@Module({
	controllers: [McpMetricsController, PrometheusMetricsController],
	providers: [
		{
			provide: McpFixedMemoryMetricsCollector,
			useFactory: () => new McpFixedMemoryMetricsCollector(),
		},
		{
			provide: MCP_CONTROL_PLANE_METRICS_OBSERVER,
			inject: [McpFixedMemoryMetricsCollector],
			useFactory: (sink: McpMetricsSink) =>
				createMcpMetricsObserver(sink, {
					projection: {
						includeTarget: false,
						maxAttributes: 8,
						maxStringLength: 128,
					},
				}),
		},
	],
	exports: [MCP_CONTROL_PLANE_METRICS_OBSERVER],
})
export class McpMetricsModule {}
