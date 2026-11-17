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

export type McpLogLevel = "debug" | "info" | "warn" | "error";

export interface McpStructuredLogRecord {
	readonly level: McpLogLevel;
	readonly event: McpLifecycleEvent["type"];
	readonly message: string;
	readonly timestamp: number;
	readonly attributes: McpTelemetryAttributes;
}

/** Minimal adapter implemented by structured loggers such as Pino or Winston. */
export interface McpStructuredLogSink {
	write(record: McpStructuredLogRecord): MaybePromise<void>;
}

export interface McpLoggerObserverOptions<
	Context extends McpOperationContext = McpOperationContext,
> {
	readonly projection?: McpTelemetryProjectionOptions<Context>;
	/** Explicit event-aware attributes; values remain bounded and redacted by `projection`. */
	readonly selectAttributes?: (event: McpLifecycleEvent<Context>) => McpAttributes;
	readonly levels?: Partial<Record<McpLifecycleEvent["type"], McpLogLevel | false>>;
	/** Explicit message override. Default messages never contain identifiers or errors. */
	readonly message?: (event: McpLifecycleEvent<Context>) => string;
}

const DEFAULT_LEVELS: Readonly<Record<McpLifecycleEvent["type"], McpLogLevel>> = Object.freeze({
	"operation.started": "debug",
	"operation.succeeded": "info",
	"operation.failed": "error",
	"operation.cancelled": "warn",
});

const DEFAULT_MESSAGES: Readonly<Record<McpLifecycleEvent["type"], string>> = Object.freeze({
	"operation.started": "MCP operation started",
	"operation.succeeded": "MCP operation succeeded",
	"operation.failed": "MCP operation failed",
	"operation.cancelled": "MCP operation cancelled",
});

/** Creates a lifecycle observer that emits one bounded structured record per event. */
export function createMcpLoggerObserver<Context extends McpOperationContext = McpOperationContext>(
	sink: McpStructuredLogSink,
	options: McpLoggerObserverOptions<Context> = {},
): McpLifecycleObserver<Context> {
	if (typeof sink?.write !== "function") {
		throw new TypeError("sink.write must be a function.");
	}

	return Object.freeze({
		async onEvent(event: McpLifecycleEvent<Context>): Promise<void> {
			const level = options.levels?.[event.type] ?? DEFAULT_LEVELS[event.type];
			if (level === false) return;

			const message = options.message?.(event) ?? DEFAULT_MESSAGES[event.type];
			if (typeof message !== "string" || message.trim().length === 0) {
				throw new TypeError("log message must be a non-empty string.");
			}

			const attributes = projectMcpTelemetryAttributes(event.context, options.projection, {
				...options.selectAttributes?.(event),
				...eventAttributes(event),
			});
			await sink.write(
				Object.freeze({
					level,
					event: event.type,
					message: message.slice(0, 256),
					timestamp: event.timestamp,
					attributes,
				}),
			);
		},
	});
}

function eventAttributes(event: McpLifecycleEvent): McpAttributes {
	if (event.type === "operation.started") return { "mcp.operation.outcome": "started" };
	if (event.type === "operation.succeeded") {
		return {
			"mcp.operation.outcome": "success",
			"mcp.operation.duration_ms": event.durationMs,
		};
	}
	if (event.type === "operation.cancelled") {
		return {
			"mcp.operation.outcome": "cancelled",
			"mcp.operation.duration_ms": event.durationMs,
			"error.type": event.error.name,
			...(event.error.code === undefined ? {} : { "error.code": event.error.code }),
		};
	}
	return {
		"mcp.operation.outcome": "error",
		"mcp.operation.duration_ms": event.durationMs,
		"error.type": event.error.name,
		...(event.error.code === undefined ? {} : { "error.code": event.error.code }),
	};
}
