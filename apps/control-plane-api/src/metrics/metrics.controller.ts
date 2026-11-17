import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import { McpFixedMemoryMetricsCollector, type McpMetricsSnapshot } from "@nest-mcp/observability";

import { McpMetricsSnapshotResponseDto } from "./metrics.response.ts";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

@ApiTags("MCP metrics")
@Controller("v1/mcp/metrics")
export class McpMetricsController {
	constructor(
		@Inject(McpFixedMemoryMetricsCollector)
		private readonly metrics: McpFixedMemoryMetricsCollector,
	) {}

	@Get()
	@Header("Cache-Control", "no-store")
	@ApiOkResponse({ type: McpMetricsSnapshotResponseDto })
	snapshot(): McpMetricsSnapshot {
		return this.metrics.snapshot();
	}
}

@ApiTags("MCP metrics")
@Controller("metrics")
export class PrometheusMetricsController {
	constructor(
		@Inject(McpFixedMemoryMetricsCollector)
		private readonly metrics: McpFixedMemoryMetricsCollector,
	) {}

	@Get()
	@Header("Cache-Control", "no-store")
	@Header("Content-Type", PROMETHEUS_CONTENT_TYPE)
	@ApiProduces(PROMETHEUS_CONTENT_TYPE)
	@ApiOkResponse({ schema: { type: "string" } })
	snapshot(): string {
		return this.metrics.renderPrometheus();
	}
}
