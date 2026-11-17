import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	MCP_METRICS_BUCKET_COUNT,
	MCP_METRICS_BUCKET_MS,
	MCP_METRICS_MAX_OPERATION_GROUPS,
	McpFixedMemoryMetricsCollector,
} from "@nest-mcp/observability";

type MeasurementBatch = Parameters<McpFixedMemoryMetricsCollector["record"]>[0];
type Attributes = MeasurementBatch[number]["attributes"];

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const millisecondsSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const outcomesSchema = z
	.object({ success: countSchema, error: countSchema, cancelled: countSchema })
	.strict();
const durationSchema = z
	.object({
		count: countSchema,
		averageMs: millisecondsSchema.nullable(),
		p50Ms: millisecondsSchema.nullable(),
		p95Ms: millisecondsSchema.nullable(),
		maxMs: millisecondsSchema.nullable(),
	})
	.strict();
const aggregateSchema = z
	.object({
		started: countSchema,
		active: countSchema,
		outcomes: outcomesSchema,
		duration: durationSchema,
	})
	.strict();
const snapshotSchema = z
	.object({
		scope: z.literal("process"),
		startedAt: z.string().datetime({ offset: true }),
		capturedAt: z.string().datetime({ offset: true }),
		totals: aggregateSchema,
		window: z
			.object({
				bucketSeconds: z.number().int().min(1).max(300),
				buckets: z
					.array(
						z
							.object({
								startedAt: z.string().datetime({ offset: true }),
								started: countSchema,
								outcomes: outcomesSchema,
								duration: durationSchema,
							})
							.strict(),
					)
					.max(MCP_METRICS_BUCKET_COUNT),
			})
			.strict(),
		operations: z
			.array(
				aggregateSchema
					.extend({
						role: z.enum(["client", "server", "gateway"]),
						name: z.string().min(1).max(128),
						kind: z.enum(["request", "notification"]),
						capability: z.string().min(1).max(128).optional(),
					})
					.strict(),
			)
			.max(MCP_METRICS_MAX_OPERATION_GROUPS),
		operationsTruncated: z.boolean(),
	})
	.strict();

describe("McpFixedMemoryMetricsCollector package integration", () => {
	it("rejects clocks that cannot be represented by the dashboard date-time contract", () => {
		expect(() => new McpFixedMemoryMetricsCollector({ now: () => 253_402_300_800_000 })).toThrow(
			"valid Unix epoch timestamp",
		);
	});

	it("returns a strict process snapshot with atomic outcomes and bounded duration summaries", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });

		metrics.record(
			startedBatch(now + 1, "tools/call", "tools", {
				"mcp.operation.target": "managed-secret-runtime-id",
				"credential.token": "must-not-escape",
			}),
		);
		metrics.record(terminalBatch(now + 41, "tools/call", "success", 40, "tools"));
		metrics.record(startedBatch(now + 50, "resources/read", "resources"));
		metrics.record(terminalBatch(now + 350, "resources/read", "error", 300, "resources"));
		metrics.record(startedBatch(now + 400, "prompts/get", "prompts"));
		now += 500;

		const snapshot = snapshotSchema.parse(metrics.snapshot());
		expect(snapshot).toMatchObject({
			scope: "process",
			totals: {
				started: 3,
				active: 1,
				outcomes: { success: 1, error: 1, cancelled: 0 },
				duration: {
					count: 2,
					averageMs: 170,
					p50Ms: 50,
					p95Ms: 300,
					maxMs: 300,
				},
			},
			window: { bucketSeconds: 15 },
			operationsTruncated: false,
		});
		expect(snapshot.operations).toHaveLength(3);
		expect(snapshot.operations.find(({ name }) => name === "tools/call")).toMatchObject({
			role: "client",
			kind: "request",
			capability: "tools",
			started: 1,
			active: 0,
			outcomes: { success: 1, error: 0, cancelled: 0 },
			duration: { count: 1, averageMs: 40, p50Ms: 40, p95Ms: 40, maxMs: 40 },
		});
		expect(snapshot.window.buckets.reduce((sum, bucket) => sum + bucket.started, 0)).toBe(3);
		expect(Object.isFrozen(metrics.snapshot())).toBe(true);
		expect(JSON.stringify(snapshot)).not.toMatch(/managed-secret|credential|token/);
		expect(snapshot.totals.started).toBe(
			snapshot.totals.active +
				snapshot.totals.outcomes.success +
				snapshot.totals.outcomes.error +
				snapshot.totals.outcomes.cancelled,
		);
	});

	it("keeps lifetime totals while rotating a fixed 15-minute window", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		metrics.record(startedBatch(now + 1, "ping"));
		metrics.record(terminalBatch(now + 2, "ping", "success", 1));

		now += MCP_METRICS_BUCKET_MS * (MCP_METRICS_BUCKET_COUNT + 1);
		const snapshot = snapshotSchema.parse(metrics.snapshot());
		expect(snapshot.totals).toMatchObject({
			started: 1,
			active: 0,
			outcomes: { success: 1, error: 0, cancelled: 0 },
		});
		expect(snapshot.window.buckets).toHaveLength(MCP_METRICS_BUCKET_COUNT);
		expect(snapshot.window.buckets.reduce((sum, bucket) => sum + bucket.started, 0)).toBe(0);
		expect(
			snapshot.window.buckets.every((bucket) =>
				Object.values(bucket.duration).every((value) => value === 0 || value === null),
			),
		).toBe(true);
		const bucketTimes = snapshot.window.buckets.map(({ startedAt }) => Date.parse(startedAt));
		expect(
			bucketTimes.every((time, index) => index === 0 || time > (bucketTimes[index - 1] ?? 0)),
		).toBe(true);
	});

	it("does not let a delayed sample overwrite the current modulo ring slot", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		now += MCP_METRICS_BUCKET_MS * MCP_METRICS_BUCKET_COUNT;
		metrics.record(startedBatch(now, "current-operation"));
		expect(metrics.snapshot().window.buckets.reduce((sum, bucket) => sum + bucket.started, 0)).toBe(
			1,
		);

		metrics.record(
			startedBatch(now - MCP_METRICS_BUCKET_MS * MCP_METRICS_BUCKET_COUNT, "delayed-operation"),
		);
		const snapshot = snapshotSchema.parse(metrics.snapshot());
		expect(snapshot.totals.started).toBe(2);
		expect(snapshot.window.buckets.reduce((sum, bucket) => sum + bucket.started, 0)).toBe(1);
		expect(snapshot.window.buckets.at(-1)?.started).toBe(1);
	});

	it("folds excess operation dimensions into a bounded other group", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		for (let index = 0; index < 110; index += 1) {
			const timestamp = now + index * 2;
			metrics.record(startedBatch(timestamp, `custom/op-${String(index)}`));
			metrics.record(terminalBatch(timestamp + 1, `custom/op-${String(index)}`, "success", 1));
		}
		now += 500;

		const snapshot = snapshotSchema.parse(metrics.snapshot());
		expect(snapshot.totals).toMatchObject({
			started: 110,
			active: 0,
			outcomes: { success: 110, error: 0, cancelled: 0 },
		});
		expect(snapshot.operationsTruncated).toBe(true);
		expect(snapshot.operations.length).toBeLessThanOrEqual(MCP_METRICS_MAX_OPERATION_GROUPS);
		expect(snapshot.operations.find(({ name }) => name === "other")).toMatchObject({
			started: 16,
			outcomes: { success: 16, error: 0, cancelled: 0 },
		});
	});

	it("keeps lossy dimensions separate from a legitimate operation named other", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		metrics.record(startedBatch(now, "other", "tools"));
		metrics.record(terminalBatch(now + 1, "other", "success", 1, "tools"));
		metrics.record(startedBatch(now + 2, "bad name", "tools"));
		metrics.record(terminalBatch(now + 3, "bad name", "error", 1, "tools"));
		metrics.record(startedBatch(now + 4, "valid-name", "bad capability"));
		metrics.record(terminalBatch(now + 5, "valid-name", "cancelled", 1, "bad capability"));
		now += 10;

		const snapshot = snapshotSchema.parse(metrics.snapshot());
		expect(snapshot.operationsTruncated).toBe(true);
		expect(snapshot.operations).toHaveLength(2);
		expect(snapshot.operations.find(({ capability }) => capability === "tools")).toMatchObject({
			name: "other",
			started: 1,
			outcomes: { success: 1, error: 0, cancelled: 0 },
		});
		expect(snapshot.operations.find(({ capability }) => capability === undefined)).toMatchObject({
			name: "other",
			started: 2,
			outcomes: { success: 0, error: 1, cancelled: 1 },
		});
	});

	it("ignores malformed or unpaired lifecycle batches", () => {
		const now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		metrics.record(terminalBatch(now, "tools/call", "error", 10, "tools"));
		metrics.record([
			{
				name: "mcp.operation.started",
				kind: "counter",
				value: 1,
				unit: "1",
				timestamp: now,
				attributes: operationAttributes("tools/call", "tools"),
			},
		]);

		expect(metrics.snapshot().totals).toMatchObject({
			started: 0,
			active: 0,
			outcomes: { success: 0, error: 0, cancelled: 0 },
			duration: { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null },
		});
		expect(metrics.snapshot().operations).toEqual([]);
	});

	it("renders aggregate Prometheus metrics with fixed labels only", () => {
		let now = 1_700_000_000_000;
		const metrics = new McpFixedMemoryMetricsCollector({ now: () => now });
		metrics.record(
			startedBatch(now, "tools/call", "tools", {
				"mcp.operation.target": "managed-high-cardinality-secret",
			}),
		);
		metrics.record(terminalBatch(now + 25, "tools/call", "success", 25, "tools"));
		now += 30;

		const rendered = metrics.renderPrometheus();
		expect(rendered).toContain("# TYPE nest_mcp_operations_started_total counter");
		expect(rendered).toContain("nest_mcp_operations_started_total 1");
		expect(rendered).toContain('nest_mcp_operations_completed_total{outcome="success"} 1');
		expect(rendered).toContain('nest_mcp_operation_duration_seconds_bucket{le="+Inf"} 1');
		expect(rendered).toContain("nest_mcp_operation_duration_seconds_count 1");
		expect(rendered.endsWith("\n")).toBe(true);
		expect(rendered).not.toMatch(
			/tools\/call|managed-high-cardinality|target|connection|generation/,
		);
	});
});

function startedBatch(
	timestamp: number,
	name: string,
	capability?: string,
	extraAttributes: Attributes = {},
): MeasurementBatch {
	const attributes = Object.freeze({
		...operationAttributes(name, capability),
		...extraAttributes,
	});
	return Object.freeze([
		Object.freeze({
			name: "mcp.operation.started",
			kind: "counter" as const,
			value: 1,
			unit: "1" as const,
			timestamp,
			attributes,
		}),
		Object.freeze({
			name: "mcp.operation.active",
			kind: "up-down-counter" as const,
			value: 1,
			unit: "1" as const,
			timestamp,
			attributes,
		}),
	]);
}

function terminalBatch(
	timestamp: number,
	name: string,
	outcome: "success" | "error" | "cancelled",
	durationMs: number,
	capability?: string,
): MeasurementBatch {
	const activeAttributes = operationAttributes(name, capability);
	const completedAttributes = Object.freeze({
		...activeAttributes,
		"mcp.operation.outcome": outcome,
	});
	return Object.freeze([
		Object.freeze({
			name: "mcp.operation.completed",
			kind: "counter" as const,
			value: 1,
			unit: "1" as const,
			timestamp,
			attributes: completedAttributes,
		}),
		Object.freeze({
			name: "mcp.operation.active",
			kind: "up-down-counter" as const,
			value: -1,
			unit: "1" as const,
			timestamp,
			attributes: activeAttributes,
		}),
		Object.freeze({
			name: "mcp.operation.duration",
			kind: "histogram" as const,
			value: durationMs,
			unit: "ms" as const,
			timestamp,
			attributes: completedAttributes,
		}),
	]);
}

function operationAttributes(name: string, capability?: string): Attributes {
	return Object.freeze({
		"mcp.runtime.role": "client",
		"mcp.operation.name": name,
		"mcp.operation.kind": "request",
		...(capability === undefined ? {} : { "mcp.operation.capability": capability }),
	});
}
