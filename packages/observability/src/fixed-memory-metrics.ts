import type { McpMetricMeasurement, McpMetricsSink } from "./metrics.ts";
import {
	McpDurationHistogram,
	addMcpMetricCount as saturatingAdd,
	type McpDurationHistogramState,
} from "./duration-histogram.ts";

/**
 * Fixed-memory aggregation vocabulary for a process-local MCP metrics sink.
 * The bucket geometry is a 15-minute rolling window, and the histogram bounds
 * are the only duration resolution exposed by the snapshot.
 */
export const MCP_METRICS_BUCKET_MS = 15_000;
export const MCP_METRICS_BUCKET_COUNT = 60;
export const MCP_METRICS_MAX_OPERATION_GROUPS = 100;

export const MCP_METRICS_HISTOGRAM_BOUNDS_MS = Object.freeze([
	5,
	10,
	25,
	50,
	100,
	250,
	500,
	1_000,
	2_500,
	5_000,
	10_000,
	30_000,
	60_000,
	120_000,
	Number.POSITIVE_INFINITY,
] as const);

const durationHistogram = new McpDurationHistogram(MCP_METRICS_HISTOGRAM_BOUNDS_MS);

export const MCP_METRIC_ROLES = Object.freeze(["client", "server", "gateway"] as const);
export const MCP_METRIC_OPERATION_KINDS = Object.freeze(["request", "notification"] as const);
export const MCP_METRIC_OUTCOMES = Object.freeze(["success", "error", "cancelled"] as const);

export type McpMetricRole = (typeof MCP_METRIC_ROLES)[number];
export type McpMetricOperationKind = (typeof MCP_METRIC_OPERATION_KINDS)[number];
export type McpMetricOutcome = (typeof MCP_METRIC_OUTCOMES)[number];

export interface McpMetricOutcomesSnapshot {
	readonly success: number;
	readonly error: number;
	readonly cancelled: number;
}

/** Percentiles are fixed-histogram estimates clamped by the observed maximum. */
export interface McpMetricDurationSnapshot {
	readonly count: number;
	readonly averageMs: number | null;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly maxMs: number | null;
}

export interface McpMetricAggregateSnapshot {
	readonly started: number;
	readonly active: number;
	readonly outcomes: McpMetricOutcomesSnapshot;
	readonly duration: McpMetricDurationSnapshot;
}

export interface McpMetricBucketSnapshot {
	readonly startedAt: string;
	readonly started: number;
	readonly outcomes: McpMetricOutcomesSnapshot;
	readonly duration: McpMetricDurationSnapshot;
}

export interface McpMetricOperationSnapshot extends McpMetricAggregateSnapshot {
	readonly role: McpMetricRole;
	readonly name: string;
	readonly kind: McpMetricOperationKind;
	readonly capability?: string;
}

export interface McpMetricsWindowSnapshot {
	readonly bucketSeconds: number;
	readonly buckets: readonly McpMetricBucketSnapshot[];
}

export interface McpMetricsSnapshot {
	readonly scope: "process";
	readonly startedAt: string;
	readonly capturedAt: string;
	readonly totals: McpMetricAggregateSnapshot;
	readonly window: McpMetricsWindowSnapshot;
	readonly operations: readonly McpMetricOperationSnapshot[];
	readonly operationsTruncated: boolean;
}

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_FOUR_DIGIT_YEAR_TIMESTAMP_MS = 253_402_300_799_999;
const OVERFLOW_GROUP_RESERVATION = MCP_METRIC_ROLES.length * MCP_METRIC_OPERATION_KINDS.length;
const MAX_CONCRETE_OPERATION_GROUPS = MCP_METRICS_MAX_OPERATION_GROUPS - OVERFLOW_GROUP_RESERVATION;
const OPERATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;

export interface McpFixedMemoryMetricsCollectorOptions {
	/** Unix epoch milliseconds. Injectable for deterministic tests. */
	readonly now?: () => number;
}

interface OperationDimension {
	readonly role: McpMetricRole;
	readonly name: string;
	readonly kind: McpMetricOperationKind;
	readonly capability?: string;
}

interface ProjectedOperationDimension {
	readonly dimension: OperationDimension;
	readonly lossy: boolean;
}

interface MutableOutcomes {
	success: number;
	error: number;
	cancelled: number;
}

type MutableDuration = McpDurationHistogramState;

interface MutableAggregate {
	started: number;
	active: number;
	readonly outcomes: MutableOutcomes;
	readonly duration: MutableDuration;
}

interface BucketSlot {
	startMs: number;
	aggregate: MutableAggregate;
}

interface StartedBatch {
	readonly timestamp: number;
	readonly operation: ProjectedOperationDimension;
}

interface TerminalBatch extends StartedBatch {
	readonly outcome: McpMetricOutcome;
	readonly durationMs: number;
}

/**
 * Process-local, fixed-memory sink for the canonical batches emitted by
 * `createMcpMetricsObserver`. It retains counters and fixed histogram bins,
 * never operation inputs, outputs, targets, request IDs, or raw errors.
 *
 * Malformed, partial, renamed, or dimension-inconsistent batches are ignored
 * atomically. Recording is synchronous and never applies backpressure.
 */
export class McpFixedMemoryMetricsCollector implements McpMetricsSink {
	readonly #now: () => number;
	readonly #startedAtMs: number;
	readonly #totals = mutableAggregate();
	readonly #operations = new Map<
		string,
		{ dimension: OperationDimension; aggregate: MutableAggregate }
	>();
	readonly #buckets: Array<BucketSlot | undefined> = Array.from({
		length: MCP_METRICS_BUCKET_COUNT,
	});
	#concreteOperationGroupCount = 0;
	#operationsTruncated = false;

	constructor(options: McpFixedMemoryMetricsCollectorOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#startedAtMs = readTimestamp(this.#now);
	}

	record(measurements: readonly McpMetricMeasurement[]): void {
		const started = parseStartedBatch(measurements);
		if (started !== undefined) {
			this.#recordStarted(started);
			return;
		}

		const terminal = parseTerminalBatch(measurements);
		if (terminal !== undefined) this.#recordTerminal(terminal);
	}

	snapshot(): McpMetricsSnapshot {
		const capturedAtMs = Math.max(this.#startedAtMs, readTimestamp(this.#now));
		const operations = [...this.#operations.values()]
			.map(({ dimension, aggregate }) => operationView(dimension, aggregate))
			.toSorted(compareOperations);
		return Object.freeze({
			scope: "process" as const,
			startedAt: toIsoTimestamp(this.#startedAtMs),
			capturedAt: toIsoTimestamp(capturedAtMs),
			totals: aggregateView(this.#totals),
			window: Object.freeze({
				bucketSeconds: MCP_METRICS_BUCKET_MS / 1_000,
				buckets: this.#bucketViews(capturedAtMs),
			}),
			operations: Object.freeze(operations),
			operationsTruncated: this.#operationsTruncated,
		});
	}

	renderPrometheus(): string {
		const lines = [
			"# HELP nest_mcp_process_start_time_seconds Unix time when this in-memory MCP collector started.",
			"# TYPE nest_mcp_process_start_time_seconds gauge",
			`nest_mcp_process_start_time_seconds ${formatPrometheusNumber(this.#startedAtMs / 1_000)}`,
			"# HELP nest_mcp_operations_started_total MCP logical operations started in this process.",
			"# TYPE nest_mcp_operations_started_total counter",
			`nest_mcp_operations_started_total ${String(this.#totals.started)}`,
			"# HELP nest_mcp_operations_completed_total MCP logical operations completed in this process by bounded outcome.",
			"# TYPE nest_mcp_operations_completed_total counter",
			`nest_mcp_operations_completed_total{outcome="success"} ${String(this.#totals.outcomes.success)}`,
			`nest_mcp_operations_completed_total{outcome="error"} ${String(this.#totals.outcomes.error)}`,
			`nest_mcp_operations_completed_total{outcome="cancelled"} ${String(this.#totals.outcomes.cancelled)}`,
			"# HELP nest_mcp_operations_active MCP logical operations currently active in this process.",
			"# TYPE nest_mcp_operations_active gauge",
			`nest_mcp_operations_active ${String(this.#totals.active)}`,
			"# HELP nest_mcp_operation_duration_seconds MCP logical operation duration in seconds.",
			"# TYPE nest_mcp_operation_duration_seconds histogram",
		];

		let cumulative = 0;
		for (const [index, boundMs] of MCP_METRICS_HISTOGRAM_BOUNDS_MS.entries()) {
			cumulative = saturatingAdd(cumulative, this.#totals.duration.bins[index] ?? 0);
			const bound = Number.isFinite(boundMs) ? formatPrometheusNumber(boundMs / 1_000) : "+Inf";
			lines.push(`nest_mcp_operation_duration_seconds_bucket{le="${bound}"} ${String(cumulative)}`);
		}
		lines.push(
			`nest_mcp_operation_duration_seconds_sum ${formatPrometheusNumber(this.#totals.duration.sumMs / 1_000)}`,
			`nest_mcp_operation_duration_seconds_count ${String(this.#totals.duration.count)}`,
			"# HELP nest_mcp_operation_groups Number of bounded operation groups retained for the JSON dashboard.",
			"# TYPE nest_mcp_operation_groups gauge",
			`nest_mcp_operation_groups ${String(this.#operations.size)}`,
			"# HELP nest_mcp_operation_groups_truncated Whether operation-group overflow has been folded into bounded other groups.",
			"# TYPE nest_mcp_operation_groups_truncated gauge",
			`nest_mcp_operation_groups_truncated ${this.#operationsTruncated ? "1" : "0"}`,
		);
		return `${lines.join("\n")}\n`;
	}

	#recordStarted(batch: StartedBatch): void {
		if (batch.timestamp < this.#startedAtMs) return;
		const operation = this.#operationAggregate(batch.operation);
		incrementStarted(this.#totals);
		incrementStarted(operation);
		const bucket = this.#bucket(batch.timestamp);
		if (bucket !== undefined) incrementStarted(bucket);
	}

	#recordTerminal(batch: TerminalBatch): void {
		if (batch.timestamp < this.#startedAtMs) return;
		if (this.#totals.active === 0) return;
		const operation = this.#existingOperationAggregate(batch.operation);
		if (operation === undefined || operation.active === 0) return;
		incrementTerminal(this.#totals, batch.outcome, batch.durationMs);
		incrementTerminal(operation, batch.outcome, batch.durationMs);
		const bucket = this.#bucket(batch.timestamp);
		if (bucket !== undefined) {
			incrementBucketTerminal(bucket, batch.outcome, batch.durationMs);
		}
	}

	#existingOperationAggregate(
		projected: ProjectedOperationDimension,
	): MutableAggregate | undefined {
		if (projected.lossy) {
			return this.#operations.get(operationKey(toOverflowDimension(projected.dimension)))
				?.aggregate;
		}
		const exact = this.#operations.get(operationKey(projected.dimension));
		if (exact !== undefined) return exact.aggregate;
		if (this.#concreteOperationGroupCount < MAX_CONCRETE_OPERATION_GROUPS) {
			return undefined;
		}
		return this.#operations.get(operationKey(toOverflowDimension(projected.dimension)))?.aggregate;
	}

	#operationAggregate(projected: ProjectedOperationDimension): MutableAggregate {
		let dimension: OperationDimension;
		let key: string;
		if (projected.lossy) {
			this.#operationsTruncated = true;
			dimension = toOverflowDimension(projected.dimension);
			key = operationKey(dimension);
			const overflow = this.#operations.get(key);
			if (overflow !== undefined) return overflow.aggregate;
		} else {
			dimension = projected.dimension;
			key = operationKey(dimension);
			const current = this.#operations.get(key);
			if (current !== undefined) return current.aggregate;
			if (this.#concreteOperationGroupCount >= MAX_CONCRETE_OPERATION_GROUPS) {
				this.#operationsTruncated = true;
				dimension = toOverflowDimension(dimension);
				key = operationKey(dimension);
				const overflow = this.#operations.get(key);
				if (overflow !== undefined) return overflow.aggregate;
			} else {
				this.#concreteOperationGroupCount += 1;
			}
		}

		const aggregate = mutableAggregate();
		this.#operations.set(key, { dimension, aggregate });
		return aggregate;
	}

	#bucket(timestamp: number): MutableAggregate | undefined {
		const startMs = bucketStart(timestamp);
		const currentStartMs = bucketStart(Math.max(this.#startedAtMs, readTimestamp(this.#now)));
		const retainedStartMs = currentStartMs - (MCP_METRICS_BUCKET_COUNT - 1) * MCP_METRICS_BUCKET_MS;
		if (startMs < retainedStartMs || startMs > currentStartMs) return undefined;
		const index = bucketIndex(startMs);
		let slot = this.#buckets[index];
		if (slot?.startMs !== startMs) {
			slot = { startMs, aggregate: mutableAggregate() };
			this.#buckets[index] = slot;
		}
		return slot.aggregate;
	}

	#bucketViews(capturedAtMs: number): readonly McpMetricBucketSnapshot[] {
		const currentStartMs = bucketStart(capturedAtMs);
		const retainedStartMs = currentStartMs - (MCP_METRICS_BUCKET_COUNT - 1) * MCP_METRICS_BUCKET_MS;
		const processStartBucketMs = bucketStart(this.#startedAtMs);
		const firstStartMs = Math.max(retainedStartMs, processStartBucketMs);
		const buckets: McpMetricBucketSnapshot[] = [];
		for (let startMs = firstStartMs; startMs <= currentStartMs; startMs += MCP_METRICS_BUCKET_MS) {
			const slot = this.#buckets[bucketIndex(startMs)];
			const aggregate = slot?.startMs === startMs ? slot.aggregate : mutableAggregate();
			buckets.push(
				Object.freeze({
					startedAt: toIsoTimestamp(Math.max(startMs, this.#startedAtMs)),
					started: aggregate.started,
					outcomes: outcomesView(aggregate.outcomes),
					duration: durationView(aggregate.duration),
				}),
			);
		}
		return Object.freeze(buckets);
	}
}

function toOverflowDimension(dimension: OperationDimension): OperationDimension {
	return Object.freeze({
		role: dimension.role,
		name: "other",
		kind: dimension.kind,
	});
}

function parseStartedBatch(
	measurements: readonly McpMetricMeasurement[],
): StartedBatch | undefined {
	if (measurements.length !== 2) return undefined;
	const started = measurements.find(
		(measurement) =>
			measurement.name === "mcp.operation.started" &&
			measurement.kind === "counter" &&
			measurement.unit === "1" &&
			measurement.value === 1,
	);
	const active = measurements.find(
		(measurement) =>
			measurement.name === "mcp.operation.active" &&
			measurement.kind === "up-down-counter" &&
			measurement.unit === "1" &&
			measurement.value === 1,
	);
	if (started === undefined || active === undefined || started.timestamp !== active.timestamp) {
		return undefined;
	}
	const operation = sameOperation(started, active);
	if (operation === undefined || !validTimestamp(started.timestamp)) return undefined;
	return Object.freeze({ timestamp: started.timestamp, operation });
}

function parseTerminalBatch(
	measurements: readonly McpMetricMeasurement[],
): TerminalBatch | undefined {
	if (measurements.length !== 3) return undefined;
	const completed = measurements.find(
		(measurement) =>
			measurement.name === "mcp.operation.completed" &&
			measurement.kind === "counter" &&
			measurement.unit === "1" &&
			measurement.value === 1,
	);
	const active = measurements.find(
		(measurement) =>
			measurement.name === "mcp.operation.active" &&
			measurement.kind === "up-down-counter" &&
			measurement.unit === "1" &&
			measurement.value === -1,
	);
	const duration = measurements.find(
		(measurement) =>
			measurement.name === "mcp.operation.duration" &&
			measurement.kind === "histogram" &&
			measurement.unit === "ms" &&
			Number.isFinite(measurement.value) &&
			measurement.value >= 0 &&
			measurement.value <= MAX_SAFE_COUNT,
	);
	if (completed === undefined || active === undefined || duration === undefined) return undefined;
	if (
		completed.timestamp !== active.timestamp ||
		completed.timestamp !== duration.timestamp ||
		!validTimestamp(completed.timestamp)
	) {
		return undefined;
	}
	const completedOperation = sameOperation(completed, active);
	const durationOperation = sameOperation(completed, duration);
	if (
		completedOperation === undefined ||
		durationOperation === undefined ||
		operationKey(completedOperation.dimension) !== operationKey(durationOperation.dimension)
	) {
		return undefined;
	}
	const outcome = readOutcome(completed.attributes["mcp.operation.outcome"]);
	if (
		outcome === undefined ||
		readOutcome(duration.attributes["mcp.operation.outcome"]) !== outcome
	) {
		return undefined;
	}
	return Object.freeze({
		timestamp: completed.timestamp,
		operation: Object.freeze({
			dimension: completedOperation.dimension,
			lossy: completedOperation.lossy || durationOperation.lossy,
		}),
		outcome,
		durationMs: duration.value,
	});
}

function sameOperation(
	left: McpMetricMeasurement,
	right: McpMetricMeasurement,
): ProjectedOperationDimension | undefined {
	const leftOperation = projectOperation(left);
	const rightOperation = projectOperation(right);
	if (
		leftOperation === undefined ||
		rightOperation === undefined ||
		operationKey(leftOperation.dimension) !== operationKey(rightOperation.dimension)
	) {
		return undefined;
	}
	return Object.freeze({
		dimension: leftOperation.dimension,
		lossy: leftOperation.lossy || rightOperation.lossy,
	});
}

function projectOperation(
	measurement: McpMetricMeasurement,
): ProjectedOperationDimension | undefined {
	const role = measurement.attributes["mcp.runtime.role"];
	const kind = measurement.attributes["mcp.operation.kind"];
	if (!isRole(role) || !isOperationKind(kind)) return undefined;

	const rawName = measurement.attributes["mcp.operation.name"];
	const validName = typeof rawName === "string" && OPERATION_NAME_PATTERN.test(rawName);
	const capability = measurement.attributes["mcp.operation.capability"];
	const validCapability =
		capability === undefined ||
		(typeof capability === "string" && CAPABILITY_PATTERN.test(capability));
	return Object.freeze({
		dimension: Object.freeze({
			role,
			name: validName ? rawName : "other",
			kind,
			...(validCapability && typeof capability === "string" ? { capability } : {}),
		}),
		lossy: !validName || !validCapability,
	});
}

function readOutcome(value: unknown): McpMetricOutcome | undefined {
	return value === "success" || value === "error" || value === "cancelled" ? value : undefined;
}

function isRole(value: unknown): value is McpMetricRole {
	return value === "client" || value === "server" || value === "gateway";
}

function isOperationKind(value: unknown): value is McpMetricOperationKind {
	return value === "request" || value === "notification";
}

function mutableAggregate(): MutableAggregate {
	return {
		started: 0,
		active: 0,
		outcomes: { success: 0, error: 0, cancelled: 0 },
		duration: durationHistogram.create(),
	};
}

function incrementStarted(aggregate: MutableAggregate): void {
	aggregate.started = saturatingAdd(aggregate.started, 1);
	aggregate.active = saturatingAdd(aggregate.active, 1);
}

function incrementTerminal(
	aggregate: MutableAggregate,
	outcome: McpMetricOutcome,
	durationMs: number,
): void {
	aggregate.active = Math.max(0, aggregate.active - 1);
	incrementBucketTerminal(aggregate, outcome, durationMs);
}

function incrementBucketTerminal(
	aggregate: MutableAggregate,
	outcome: McpMetricOutcome,
	durationMs: number,
): void {
	aggregate.outcomes[outcome] = saturatingAdd(aggregate.outcomes[outcome], 1);
	durationHistogram.record(aggregate.duration, durationMs);
}

function aggregateView(aggregate: MutableAggregate): McpMetricAggregateSnapshot {
	return Object.freeze({
		started: aggregate.started,
		active: aggregate.active,
		outcomes: outcomesView(aggregate.outcomes),
		duration: durationView(aggregate.duration),
	});
}

function operationView(
	dimension: OperationDimension,
	aggregate: MutableAggregate,
): McpMetricOperationSnapshot {
	return Object.freeze({ ...dimension, ...aggregateView(aggregate) });
}

function outcomesView(outcomes: MutableOutcomes): McpMetricOutcomesSnapshot {
	return Object.freeze({ ...outcomes });
}

function durationView(duration: MutableDuration): McpMetricDurationSnapshot {
	return durationHistogram.summarize(duration);
}

function compareOperations(
	left: McpMetricOperationSnapshot,
	right: McpMetricOperationSnapshot,
): number {
	return (
		left.role.localeCompare(right.role) ||
		left.name.localeCompare(right.name) ||
		left.kind.localeCompare(right.kind) ||
		(left.capability ?? "").localeCompare(right.capability ?? "")
	);
}

function operationKey(dimension: OperationDimension): string {
	return JSON.stringify([
		dimension.role,
		dimension.name,
		dimension.kind,
		dimension.capability ?? null,
	]);
}

function bucketStart(timestamp: number): number {
	return Math.floor(timestamp / MCP_METRICS_BUCKET_MS) * MCP_METRICS_BUCKET_MS;
}

function bucketIndex(startMs: number): number {
	const epoch = Math.floor(startMs / MCP_METRICS_BUCKET_MS);
	return ((epoch % MCP_METRICS_BUCKET_COUNT) + MCP_METRICS_BUCKET_COUNT) % MCP_METRICS_BUCKET_COUNT;
}

function validTimestamp(timestamp: number): boolean {
	return (
		Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= MAX_FOUR_DIGIT_YEAR_TIMESTAMP_MS
	);
}

function readTimestamp(now: () => number): number {
	const timestamp = now();
	if (!validTimestamp(timestamp)) {
		throw new TypeError("Metrics clock must return a valid Unix epoch timestamp.");
	}
	return timestamp;
}

function toIsoTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function formatPrometheusNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));
}
