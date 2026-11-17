import { describe, expect, it } from "vitest";

import {
	MCP_METRICS_BUCKET_COUNT,
	MCP_METRICS_BUCKET_MS,
	MCP_METRICS_MAX_OPERATION_GROUPS,
	McpFixedMemoryMetricsCollector,
	type McpMetricMeasurement,
} from "../src/metrics.ts";

// Divisible by the bucket width so bucket arithmetic in the assertions is exact.
const EPOCH = 1_800_000_000_000;

type Attributes = Record<string, string | number | boolean>;

interface Dimension {
	readonly role?: string;
	readonly kind?: string;
	readonly name?: string;
	readonly capability?: string;
}

function attributes(dimension: Dimension = {}): Attributes {
	const projected: Attributes = {
		"mcp.runtime.role": dimension.role ?? "client",
		"mcp.operation.kind": dimension.kind ?? "request",
	};
	const name = dimension.name ?? "tools/call";
	projected["mcp.operation.name"] = name;
	if (dimension.capability !== undefined) {
		projected["mcp.operation.capability"] = dimension.capability;
	}
	return projected;
}

function startBatch(timestamp: number, dimension: Dimension = {}): McpMetricMeasurement[] {
	const shared = attributes(dimension);
	return [
		{
			name: "mcp.operation.started",
			kind: "counter",
			value: 1,
			unit: "1",
			timestamp,
			attributes: shared,
		},
		{
			name: "mcp.operation.active",
			kind: "up-down-counter",
			value: 1,
			unit: "1",
			timestamp,
			attributes: shared,
		},
	];
}

function terminalBatch(
	timestamp: number,
	durationMs: number,
	outcome: string = "success",
	dimension: Dimension = {},
): McpMetricMeasurement[] {
	const shared = attributes(dimension);
	const withOutcome = { ...shared, "mcp.operation.outcome": outcome };
	return [
		{
			name: "mcp.operation.completed",
			kind: "counter",
			value: 1,
			unit: "1",
			timestamp,
			attributes: withOutcome,
		},
		{
			name: "mcp.operation.active",
			kind: "up-down-counter",
			value: -1,
			unit: "1",
			timestamp,
			attributes: shared,
		},
		{
			name: "mcp.operation.duration",
			kind: "histogram",
			value: durationMs,
			unit: "ms",
			timestamp,
			attributes: withOutcome,
		},
	];
}

function sink(now: () => number = () => EPOCH): McpFixedMemoryMetricsCollector {
	return new McpFixedMemoryMetricsCollector({ now });
}

describe("McpFixedMemoryMetricsCollector", () => {
	it("aggregates one operation across totals, groups, and the rolling window", () => {
		const metrics = sink();
		metrics.record(startBatch(EPOCH, { capability: "tools" }));
		metrics.record(terminalBatch(EPOCH, 42, "success", { capability: "tools" }));

		const snapshot = metrics.snapshot();
		expect(snapshot.scope).toBe("process");
		expect(snapshot.startedAt).toBe(new Date(EPOCH).toISOString());
		expect(snapshot.capturedAt).toBe(new Date(EPOCH).toISOString());
		expect(snapshot.totals).toEqual({
			started: 1,
			active: 0,
			outcomes: { success: 1, error: 0, cancelled: 0 },
			// The 50ms bin bound is clamped down to the observed maximum.
			duration: { count: 1, averageMs: 42, p50Ms: 42, p95Ms: 42, maxMs: 42 },
		});
		expect(snapshot.operations).toEqual([
			{
				role: "client",
				name: "tools/call",
				kind: "request",
				capability: "tools",
				started: 1,
				active: 0,
				outcomes: { success: 1, error: 0, cancelled: 0 },
				// The 50ms bin bound is clamped down to the observed maximum.
				duration: { count: 1, averageMs: 42, p50Ms: 42, p95Ms: 42, maxMs: 42 },
			},
		]);
		expect(snapshot.operationsTruncated).toBe(false);
		expect(snapshot.window.bucketSeconds).toBe(MCP_METRICS_BUCKET_MS / 1_000);
		expect(snapshot.window.buckets).toEqual([
			{
				startedAt: new Date(EPOCH).toISOString(),
				started: 1,
				outcomes: { success: 1, error: 0, cancelled: 0 },
				// The 50ms bin bound is clamped down to the observed maximum.
				duration: { count: 1, averageMs: 42, p50Ms: 42, p95Ms: 42, maxMs: 42 },
			},
		]);
	});

	it("sorts operation groups by role, name, kind, then capability", () => {
		const metrics = sink();
		for (const dimension of [
			{ role: "server", name: "b" },
			{ role: "client", name: "b", capability: "tools" },
			{ role: "client", name: "b", capability: "prompts" },
			{ role: "client", name: "a" },
			{ role: "client", name: "b", kind: "notification" },
			{ role: "client", name: "b" },
		]) {
			metrics.record(startBatch(EPOCH, dimension));
		}

		expect(
			metrics
				.snapshot()
				.operations.map(
					(operation) =>
						`${operation.role}/${operation.name}/${operation.kind}/${operation.capability ?? ""}`,
				),
		).toEqual([
			"client/a/request/",
			"client/b/notification/",
			"client/b/request/",
			"client/b/request/prompts",
			"client/b/request/tools",
			"server/b/request/",
		]);
	});

	it.each([
		["a batch of the wrong length", () => startBatch(EPOCH).slice(0, 1)],
		[
			"a start batch whose measurements disagree on the timestamp",
			() => {
				const [started, active] = startBatch(EPOCH);
				return [started!, { ...active!, timestamp: EPOCH + 1 }];
			},
		],
		[
			"a start batch whose measurements disagree on the dimension",
			() => [startBatch(EPOCH)[0]!, startBatch(EPOCH, { name: "other/op" })[1]!],
		],
		[
			"a start batch with the wrong metric kind",
			() => {
				const [started, active] = startBatch(EPOCH);
				return [{ ...started!, kind: "histogram" as const }, active!];
			},
		],
		["a start batch with an unknown runtime role", () => startBatch(EPOCH, { role: "proxy" })],
		["a start batch with an unknown operation kind", () => startBatch(EPOCH, { kind: "stream" })],
		["a start batch with an out-of-range timestamp", () => startBatch(Number.POSITIVE_INFINITY)],
	])("ignores %s", (_label, build) => {
		const metrics = sink();
		metrics.record(build());

		const snapshot = metrics.snapshot();
		expect(snapshot.totals.started).toBe(0);
		expect(snapshot.operations).toEqual([]);
	});

	it.each([
		[
			"the outcome disagrees between completed and duration",
			() => {
				const [completed, active, duration] = terminalBatch(EPOCH, 5);
				return [
					completed!,
					active!,
					{
						...duration!,
						attributes: {
							...duration!.attributes,
							"mcp.operation.outcome": "error",
						},
					},
				];
			},
		],
		["the outcome is not a bounded value", () => terminalBatch(EPOCH, 5, "failed")],
		["the duration is negative", () => terminalBatch(EPOCH, -1)],
		[
			"the duration unit is not milliseconds",
			() => {
				const [completed, active, duration] = terminalBatch(EPOCH, 5);
				return [completed!, active!, { ...duration!, unit: "1" as const }];
			},
		],
	])("ignores a terminal batch when %s", (_label, build) => {
		const metrics = sink();
		metrics.record(startBatch(EPOCH));
		metrics.record(build());

		const snapshot = metrics.snapshot();
		expect(snapshot.totals.active).toBe(1);
		expect(snapshot.totals.outcomes).toEqual({
			success: 0,
			error: 0,
			cancelled: 0,
		});
		expect(snapshot.totals.duration.count).toBe(0);
	});

	it("never decrements the active gauge below zero", () => {
		const metrics = sink();
		// A terminal without a start (a restart, or a dropped batch) is dropped.
		metrics.record(terminalBatch(EPOCH, 10));
		expect(metrics.snapshot().totals).toMatchObject({
			started: 0,
			active: 0,
			outcomes: { success: 0, error: 0, cancelled: 0 },
		});

		metrics.record(startBatch(EPOCH));
		metrics.record(terminalBatch(EPOCH, 10));
		metrics.record(terminalBatch(EPOCH, 10));

		const snapshot = metrics.snapshot();
		expect(snapshot.totals.active).toBe(0);
		expect(snapshot.totals.outcomes.success).toBe(1);
		expect(snapshot.operations[0]?.active).toBe(0);
	});

	it("folds dimensions past the concrete cap into bounded overflow groups", () => {
		const metrics = sink();
		const concreteCap = MCP_METRICS_MAX_OPERATION_GROUPS - 6;
		for (let index = 0; index < concreteCap; index += 1) {
			metrics.record(startBatch(EPOCH, { name: `op-${index}` }));
		}
		expect(metrics.snapshot().operationsTruncated).toBe(false);
		expect(metrics.snapshot().operations).toHaveLength(concreteCap);

		metrics.record(startBatch(EPOCH, { name: "overflow-one" }));
		metrics.record(startBatch(EPOCH, { name: "overflow-two" }));

		const snapshot = metrics.snapshot();
		expect(snapshot.operationsTruncated).toBe(true);
		expect(snapshot.operations).toHaveLength(concreteCap + 1);
		const overflow = snapshot.operations.find((operation) => operation.name === "other");
		expect(overflow).toMatchObject({ role: "client", kind: "request", started: 2 });

		// A terminal for an overflowed dimension lands on the same overflow group.
		metrics.record(terminalBatch(EPOCH, 7, "error", { name: "overflow-one" }));
		const settled = metrics.snapshot().operations.find((operation) => operation.name === "other");
		expect(settled).toMatchObject({
			started: 2,
			active: 1,
			outcomes: { success: 0, error: 1, cancelled: 0 },
		});
	});

	it("folds an unusable operation name into the bounded other group", () => {
		const metrics = sink();
		metrics.record(startBatch(EPOCH, { name: "tools/call with spaces" }));

		const snapshot = metrics.snapshot();
		expect(snapshot.operationsTruncated).toBe(true);
		expect(snapshot.operations).toEqual([
			{
				role: "client",
				name: "other",
				kind: "request",
				started: 1,
				active: 1,
				outcomes: { success: 0, error: 0, cancelled: 0 },
				duration: {
					count: 0,
					averageMs: null,
					p50Ms: null,
					p95Ms: null,
					maxMs: null,
				},
			},
		]);
	});

	it("estimates percentiles from histogram bins clamped by the observed maximum", () => {
		const metrics = sink();
		for (const durationMs of [1, 1, 1, 1, 3_000]) {
			metrics.record(startBatch(EPOCH));
			metrics.record(terminalBatch(EPOCH, durationMs));
		}

		expect(metrics.snapshot().totals.duration).toEqual({
			count: 5,
			averageMs: (4 + 3_000) / 5,
			// p50 lands in the 5ms bin; p95 crosses into the 5000ms bin and is
			// clamped down to the largest value actually observed.
			p50Ms: 5,
			p95Ms: 3_000,
			maxMs: 3_000,
		});
	});

	it("resets a reused ring slot on wraparound and drops evicted observations", () => {
		let now = EPOCH;
		const metrics = sink(() => now);
		metrics.record(startBatch(EPOCH));
		expect(metrics.snapshot().window.buckets).toHaveLength(1);

		now = EPOCH + MCP_METRICS_BUCKET_COUNT * MCP_METRICS_BUCKET_MS;
		// The original bucket is now outside the retained window, so this start is
		// counted in totals but contributes to no bucket at all.
		metrics.record(startBatch(EPOCH));
		metrics.record(startBatch(now));

		const snapshot = metrics.snapshot();
		expect(snapshot.totals.started).toBe(3);
		expect(snapshot.window.buckets).toHaveLength(MCP_METRICS_BUCKET_COUNT);
		// The ring slot the first observation used has been reclaimed, not merged.
		expect(snapshot.window.buckets.at(-1)).toMatchObject({
			startedAt: new Date(now).toISOString(),
			started: 1,
		});
		expect(snapshot.window.buckets.slice(0, -1).every((bucket) => bucket.started === 0)).toBe(true);
	});

	it("drops observations stamped before the sink was constructed", () => {
		const metrics = sink();
		metrics.record(startBatch(EPOCH - 1));

		expect(metrics.snapshot().totals.started).toBe(0);
	});

	it("clamps capturedAt forward and rejects an invalid clock", () => {
		let now = EPOCH;
		const metrics = sink(() => now);
		now = EPOCH - 60_000;
		expect(metrics.snapshot().capturedAt).toBe(new Date(EPOCH).toISOString());

		now = Number.NaN;
		expect(() => metrics.snapshot()).toThrow(TypeError);
		expect(() => new McpFixedMemoryMetricsCollector({ now: () => -1 })).toThrow(TypeError);
	});
	it("renders aggregate Prometheus metrics with fixed labels only", () => {
		const metrics = sink();
		metrics.record(
			startBatch(EPOCH, {
				name: "tools/call",
				capability: "tools",
			}),
		);
		metrics.record(terminalBatch(EPOCH + 25, 25, "success", { capability: "tools" }));

		const rendered = metrics.renderPrometheus();
		expect(rendered).toContain("# TYPE nest_mcp_operations_started_total counter");
		expect(rendered).toContain("nest_mcp_operations_started_total 1");
		expect(rendered).toContain('nest_mcp_operations_completed_total{outcome="success"} 1');
		expect(rendered).toContain('nest_mcp_operation_duration_seconds_bucket{le="+Inf"} 1');
		expect(rendered).toContain("nest_mcp_operation_duration_seconds_count 1");
		expect(rendered.endsWith("\n")).toBe(true);
		expect(rendered).not.toMatch(/tools\/call|target|connection|generation/u);
	});
});
