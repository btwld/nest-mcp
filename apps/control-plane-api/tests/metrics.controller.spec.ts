import { describe, expect, it } from "vitest";
import { McpFixedMemoryMetricsCollector } from "@nest-mcp/observability";

import {
	McpMetricsController,
	PROMETHEUS_CONTENT_TYPE,
	PrometheusMetricsController,
} from "../src/metrics/metrics.controller.ts";

describe("metrics controllers", () => {
	it("delegate the strict JSON snapshot and plain Prometheus representation", () => {
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => 1_700_000_000_000 });
		const jsonController = new McpMetricsController(metrics);
		const prometheusController = new PrometheusMetricsController(metrics);

		expect(jsonController.snapshot()).toMatchObject({
			scope: "process",
			startedAt: "2023-11-14T22:13:20.000Z",
			capturedAt: "2023-11-14T22:13:20.000Z",
			operations: [],
			operationsTruncated: false,
		});
		expect(prometheusController.snapshot()).toContain("nest_mcp_operations_started_total 0");
		expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
	});
});
