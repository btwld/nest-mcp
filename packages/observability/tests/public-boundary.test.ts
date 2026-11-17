import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	MCP_METRIC_OPERATION_KINDS,
	MCP_METRIC_OUTCOMES,
	MCP_METRIC_ROLES,
	MCP_METRICS_BUCKET_COUNT,
	MCP_METRICS_BUCKET_MS,
	MCP_METRICS_HISTOGRAM_BOUNDS_MS,
	MCP_METRICS_MAX_OPERATION_GROUPS,
	McpFixedMemoryMetricsCollector,
	type McpMetricsSnapshot,
} from "../src/index.ts";
import { McpFixedMemoryMetricsCollector as MetricsSubpathCollector } from "../src/metrics.ts";

const SOURCE_FILES = [
	"attributes.ts",
	"fixed-memory-metrics.ts",
	"index.ts",
	"logging.ts",
	"metrics.ts",
	"tracing.ts",
];

describe("@nest-mcp/observability public boundary", () => {
	it("keeps the backend-neutral package free of Nest and product imports", async () => {
		const sources = await Promise.all(
			SOURCE_FILES.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
		);
		const joined = sources.join("\n");

		expect(joined).not.toMatch(/@nestjs\//u);
		expect(joined).not.toMatch(/apps\/control-plane-api/u);
		expect(joined).not.toMatch(/InMemoryMcpMetricsService|McpMetricsSnapshotView/u);
	});

	it("exports the fixed-memory collector from the root and metrics entrypoints", () => {
		expect(McpFixedMemoryMetricsCollector).toBe(MetricsSubpathCollector);
		const snapshot: McpMetricsSnapshot = new McpFixedMemoryMetricsCollector({
			now: () => 1_800_000_000_000,
		}).snapshot();

		expect(snapshot).toMatchObject({ scope: "process", operations: [] });
		expect(MCP_METRICS_BUCKET_MS * MCP_METRICS_BUCKET_COUNT).toBe(15 * 60 * 1_000);
		expect(MCP_METRICS_MAX_OPERATION_GROUPS).toBe(100);
		for (const tuple of [
			MCP_METRIC_ROLES,
			MCP_METRIC_OPERATION_KINDS,
			MCP_METRIC_OUTCOMES,
			MCP_METRICS_HISTOGRAM_BOUNDS_MS,
		]) {
			expect(Object.isFrozen(tuple)).toBe(true);
		}
	});
});
