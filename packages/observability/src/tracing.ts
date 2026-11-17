import {
	toMcpErrorDetails,
	type McpOperation,
	type McpOperationContext,
	type McpOperationMiddleware,
	type MaybePromise,
} from "@nest-mcp/core";

import {
	projectMcpTelemetryAttributes,
	type McpTelemetryAttributes,
	type McpTelemetryProjectionOptions,
} from "./attributes.ts";

export type McpTraceSpanKind = "client" | "server" | "internal";

export interface McpTraceSpanStatus {
	readonly code: "ok" | "error";
	/** Static by default; raw operation errors are never used as descriptions. */
	readonly description?: string;
}

export interface McpTraceSpan {
	setAttributes(attributes: McpTelemetryAttributes): MaybePromise<void>;
	setStatus(status: McpTraceSpanStatus): MaybePromise<void>;
	end(endTime: number): MaybePromise<void>;
}

export interface McpTraceStartOptions {
	readonly kind: McpTraceSpanKind;
	readonly startTime: number;
	readonly attributes: McpTelemetryAttributes;
}

/**
 * Structural tracing API. An OpenTelemetry adapter can implement `withSpan`
 * using its context manager without making this package depend on OTel.
 */
export interface McpTracer {
	startSpan(name: string, options: McpTraceStartOptions): MaybePromise<McpTraceSpan>;
	withSpan?<Value>(span: McpTraceSpan, callback: () => Promise<Value>): MaybePromise<Value>;
}

export type McpTracingPhase =
	"clock" | "start" | "activate" | "attributes" | "status" | "record-error" | "end";

export interface McpTracingMiddlewareOptions<
	Input,
	Context extends McpOperationContext = McpOperationContext,
> {
	readonly projection?: McpTelemetryProjectionOptions<Context>;
	readonly now?: () => number;
	/** Explicit name override. The result is still bounded to 128 characters. */
	readonly spanName?: (context: Context) => string;
	/**
	 * Explicit raw-error hook for backend exception recording. It is disabled by
	 * default because exception exporters commonly capture messages and stacks.
	 */
	readonly recordError?: (
		span: McpTraceSpan,
		error: unknown,
		operation: McpOperation<Input, Context>,
	) => MaybePromise<void>;
	readonly onInstrumentationError?: (
		error: unknown,
		phase: McpTracingPhase,
		context: Context,
	) => MaybePromise<void>;
}

interface McpInstrumentationErrorOptions<Context extends McpOperationContext> {
	readonly onInstrumentationError?: (
		error: unknown,
		phase: McpTracingPhase,
		context: Context,
	) => MaybePromise<void>;
}

/** Creates best-effort tracing middleware that never replaces an operation result or error. */
export function createMcpTracingMiddleware<
	Input = unknown,
	Output = unknown,
	Context extends McpOperationContext = McpOperationContext,
>(
	tracer: McpTracer,
	options: McpTracingMiddlewareOptions<Input, Context> = {},
): McpOperationMiddleware<Input, Output, Context> {
	if (typeof tracer?.startSpan !== "function") {
		throw new TypeError("tracer.startSpan must be a function.");
	}
	const now = options.now ?? Date.now;

	return async (operation, next) => {
		const startTime = await readTimestampSafely(now, operation.context, options);
		let span: McpTraceSpan;
		try {
			const attributes = projectMcpTelemetryAttributes(operation.context, options.projection);
			const name = readSpanName(options.spanName?.(operation.context), operation.context);
			span = await tracer.startSpan(
				name,
				Object.freeze({ kind: spanKind(operation.context), startTime, attributes }),
			);
			assertSpan(span);
		} catch (error) {
			await reportInstrumentationError(error, "start", operation.context, options);
			return next();
		}

		try {
			const output = await runWithSpan(tracer, span, next, operation.context, options);
			const endTime = await readTimestampSafely(now, operation.context, options);
			await finishSpanSafely(span, operation, "success", endTime, undefined, options);
			return output;
		} catch (error) {
			const outcome = await readOutcomeSafely(operation.context, options);
			const endTime = await readTimestampSafely(now, operation.context, options);
			await finishSpanSafely(span, operation, outcome, endTime, error, options);
			throw error;
		}
	};
}

async function finishSpanSafely<Input, Context extends McpOperationContext>(
	span: McpTraceSpan,
	operation: McpOperation<Input, Context>,
	outcome: "success" | "error" | "cancelled",
	endTime: number,
	error: unknown,
	options: McpTracingMiddlewareOptions<Input, Context>,
): Promise<void> {
	try {
		await finishSpan(span, operation, outcome, endTime, error, options);
	} catch (instrumentationError) {
		await reportInstrumentationError(instrumentationError, "end", operation.context, options);
	}
}

async function runWithSpan<Output, Context extends McpOperationContext>(
	tracer: McpTracer,
	span: McpTraceSpan,
	next: () => Promise<Output>,
	context: Context,
	options: McpInstrumentationErrorOptions<Context>,
): Promise<Output> {
	let supportsActivation: boolean;
	try {
		supportsActivation = tracer.withSpan !== undefined;
	} catch (error) {
		await reportInstrumentationError(error, "activate", context, options);
		return next();
	}
	if (!supportsActivation) return next();

	let execution: Promise<Output> | undefined;
	const callback = (): Promise<Output> => {
		execution ??= Promise.resolve().then(next);
		return execution;
	};

	try {
		await tracer.withSpan?.(span, callback);
	} catch (activationError) {
		if (execution === undefined) {
			await reportInstrumentationError(activationError, "activate", context, options);
			return callback();
		}
		try {
			const output = await execution;
			await reportInstrumentationError(activationError, "activate", context, options);
			return output;
		} catch (operationError) {
			if (!Object.is(operationError, activationError)) {
				await reportInstrumentationError(activationError, "activate", context, options);
			}
			throw operationError;
		}
	}

	if (execution === undefined) {
		await reportInstrumentationError(
			new TypeError("tracer.withSpan must invoke its callback."),
			"activate",
			context,
			options,
		);
		return callback();
	}
	return execution;
}

async function finishSpan<Input, Context extends McpOperationContext>(
	span: McpTraceSpan,
	operation: McpOperation<Input, Context>,
	outcome: "success" | "error" | "cancelled",
	endTime: number,
	error: unknown,
	options: McpTracingMiddlewareOptions<Input, Context>,
): Promise<void> {
	let errorDetails: ReturnType<typeof toMcpErrorDetails> | undefined;
	if (error !== undefined) {
		try {
			errorDetails = toMcpErrorDetails(error);
		} catch (classificationError) {
			await reportInstrumentationError(
				classificationError,
				"attributes",
				operation.context,
				options,
			);
			errorDetails = Object.freeze({ name: "UnknownError", message: "Error details unavailable" });
		}
	}
	let attributes: McpTelemetryAttributes | undefined;
	try {
		attributes = projectMcpTelemetryAttributes(operation.context, options.projection, {
			"mcp.operation.outcome": outcome,
			...(errorDetails === undefined ? {} : { "error.type": errorDetails.name }),
			...(errorDetails?.code === undefined ? {} : { "error.code": errorDetails.code }),
		});
	} catch (projectionError) {
		await reportInstrumentationError(projectionError, "attributes", operation.context, options);
	}

	if (attributes !== undefined) {
		await safelyInvoke(
			() => span.setAttributes(attributes),
			"attributes",
			operation.context,
			options,
		);
	}
	await safelyInvoke(
		() =>
			span.setStatus(
				outcome === "success"
					? Object.freeze({ code: "ok" as const })
					: Object.freeze({
							code: "error" as const,
							description:
								outcome === "cancelled" ? "MCP operation cancelled" : "MCP operation failed",
						}),
			),
		"status",
		operation.context,
		options,
	);

	if (error !== undefined) {
		await safelyInvoke(
			async () => {
				await options.recordError?.(span, error, operation);
			},
			"record-error",
			operation.context,
			options,
		);
	}

	await safelyInvoke(() => span.end(endTime), "end", operation.context, options);
}

async function readOutcomeSafely<Context extends McpOperationContext>(
	context: Context,
	options: McpInstrumentationErrorOptions<Context>,
): Promise<"error" | "cancelled"> {
	try {
		return context.signal.aborted ? "cancelled" : "error";
	} catch (error) {
		await reportInstrumentationError(error, "status", context, options);
		return "error";
	}
}

async function safelyInvoke<Context extends McpOperationContext>(
	callback: () => MaybePromise<void>,
	phase: McpTracingPhase,
	context: Context,
	options: McpInstrumentationErrorOptions<Context>,
): Promise<void> {
	try {
		await callback();
	} catch (error) {
		await reportInstrumentationError(error, phase, context, options);
	}
}

async function reportInstrumentationError<Context extends McpOperationContext>(
	error: unknown,
	phase: McpTracingPhase,
	context: Context,
	options: McpInstrumentationErrorOptions<Context>,
): Promise<void> {
	try {
		await options.onInstrumentationError?.(error, phase, context);
	} catch {
		// Instrumentation callbacks must not affect the observed operation.
	}
}

function readSpanName(configuredName: string | undefined, context: McpOperationContext): string {
	const name = configuredName ?? `mcp ${context.role} ${context.operation.name}`;
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new TypeError("span name must be a non-empty string.");
	}
	return name.trim().slice(0, 128);
}

function spanKind(context: McpOperationContext): McpTraceSpanKind {
	if (context.role === "client") return "client";
	if (context.role === "server") return "server";
	return "internal";
}

function assertSpan(span: unknown): asserts span is McpTraceSpan {
	if (
		typeof span !== "object" ||
		span === null ||
		typeof (span as Partial<McpTraceSpan>).setAttributes !== "function" ||
		typeof (span as Partial<McpTraceSpan>).setStatus !== "function" ||
		typeof (span as Partial<McpTraceSpan>).end !== "function"
	) {
		throw new TypeError("tracer.startSpan must return an MCP trace span.");
	}
}

async function readTimestampSafely<Context extends McpOperationContext>(
	now: () => number,
	context: Context,
	options: McpInstrumentationErrorOptions<Context>,
): Promise<number> {
	try {
		const timestamp = now();
		if (!Number.isFinite(timestamp)) {
			throw new TypeError("tracing clock must return a finite value.");
		}
		return timestamp;
	} catch (error) {
		await reportInstrumentationError(error, "clock", context, options);
		try {
			const fallback = Date.now();
			return Number.isFinite(fallback) ? fallback : 0;
		} catch {
			return 0;
		}
	}
}
