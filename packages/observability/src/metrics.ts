import type {
	McpAttributes,
	McpLifecycleEvent,
	McpLifecycleObserver,
	McpOperationContext,
	MaybePromise,
} from "@nest-mcp/core";

import {
	projectMcpTelemetryAttributes,
	type McpTelemetryAttributes,
	type McpTelemetryProjectionOptions,
} from "./attributes.ts";

export type McpMetricKind = "counter" | "histogram" | "up-down-counter";

export interface McpMetricMeasurement {
	readonly name: string;
	readonly kind: McpMetricKind;
	readonly value: number;
	readonly unit: "1" | "ms";
	readonly timestamp: number;
	readonly attributes: McpTelemetryAttributes;
}

/** One batch maps cleanly to OpenTelemetry, Prometheus, StatsD, or custom collectors. */
export interface McpMetricsSink {
	record(measurements: readonly McpMetricMeasurement[]): MaybePromise<void>;
}

export interface McpMetricNames {
	readonly started: string;
	readonly completed: string;
	readonly active: string;
	readonly duration: string;
}

export interface McpMetricsObserverOptions<
	Context extends McpOperationContext = McpOperationContext,
> {
	readonly projection?: McpTelemetryProjectionOptions<Context>;
	readonly names?: Partial<McpMetricNames>;
	/** Explicit event-aware dimensions; values remain bounded and redacted by `projection`. */
	readonly selectAttributes?: (event: McpLifecycleEvent<Context>) => McpAttributes;
}

export const MCP_METRIC_NAMES: Readonly<McpMetricNames> = Object.freeze({
	started: "mcp.operation.started",
	completed: "mcp.operation.completed",
	active: "mcp.operation.active",
	duration: "mcp.operation.duration",
});

/** Creates batched counter, active-operation, and duration measurements. */
export function createMcpMetricsObserver<Context extends McpOperationContext = McpOperationContext>(
	sink: McpMetricsSink,
	options: McpMetricsObserverOptions<Context> = {},
): McpLifecycleObserver<Context> {
	if (typeof sink?.record !== "function") {
		throw new TypeError("sink.record must be a function.");
	}
	const names = Object.freeze({ ...MCP_METRIC_NAMES, ...options.names });
	for (const [key, name] of Object.entries(names)) {
		if (
			typeof name !== "string" ||
			name.length > 128 ||
			!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name)
		) {
			throw new TypeError(`names.${key} must be a valid metric name of at most 128 characters.`);
		}
	}

	return Object.freeze({
		async onEvent(event: McpLifecycleEvent<Context>): Promise<void> {
			const outcome = eventOutcome(event);
			const selectedAttributes = options.selectAttributes?.(event) ?? {};
			const activeAttributes = projectMcpTelemetryAttributes(
				event.context,
				options.projection,
				selectedAttributes,
			);
			const completedAttributes =
				outcome === undefined
					? activeAttributes
					: projectMcpTelemetryAttributes(event.context, options.projection, {
							...selectedAttributes,
							"mcp.operation.outcome": outcome,
						});
			const measurements = createMeasurements(event, activeAttributes, completedAttributes, names);
			await sink.record(measurements);
		},
	});
}

function createMeasurements(
	event: McpLifecycleEvent,
	activeAttributes: McpTelemetryAttributes,
	completedAttributes: McpTelemetryAttributes,
	names: McpMetricNames,
): readonly McpMetricMeasurement[] {
	if (event.type === "operation.started") {
		return Object.freeze([
			measurement(names.started, "counter", 1, "1", event.timestamp, completedAttributes),
			measurement(names.active, "up-down-counter", 1, "1", event.timestamp, activeAttributes),
		]);
	}

	return Object.freeze([
		measurement(names.completed, "counter", 1, "1", event.timestamp, completedAttributes),
		measurement(names.active, "up-down-counter", -1, "1", event.timestamp, activeAttributes),
		measurement(
			names.duration,
			"histogram",
			event.durationMs,
			"ms",
			event.timestamp,
			completedAttributes,
		),
	]);
}

function measurement(
	name: string,
	kind: McpMetricKind,
	value: number,
	unit: "1" | "ms",
	timestamp: number,
	attributes: McpTelemetryAttributes,
): McpMetricMeasurement {
	return Object.freeze({ name, kind, value, unit, timestamp, attributes });
}

function eventOutcome(event: McpLifecycleEvent): string | undefined {
	switch (event.type) {
		case "operation.started":
			return undefined;
		case "operation.succeeded":
			return "success";
		case "operation.failed":
			return "error";
		case "operation.cancelled":
			return "cancelled";
		default:
			return undefined;
	}
}

export {
	MCP_METRIC_OPERATION_KINDS,
	MCP_METRIC_OUTCOMES,
	MCP_METRIC_ROLES,
	MCP_METRICS_BUCKET_COUNT,
	MCP_METRICS_BUCKET_MS,
	MCP_METRICS_HISTOGRAM_BOUNDS_MS,
	MCP_METRICS_MAX_OPERATION_GROUPS,
	McpFixedMemoryMetricsCollector,
} from "./fixed-memory-metrics.ts";
export type {
	McpFixedMemoryMetricsCollectorOptions,
	McpMetricAggregateSnapshot,
	McpMetricBucketSnapshot,
	McpMetricDurationSnapshot,
	McpMetricOperationKind,
	McpMetricOperationSnapshot,
	McpMetricOutcome,
	McpMetricOutcomesSnapshot,
	McpMetricRole,
	McpMetricsSnapshot,
	McpMetricsWindowSnapshot,
} from "./fixed-memory-metrics.ts";
