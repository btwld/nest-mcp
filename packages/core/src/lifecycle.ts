import type { McpOperationContext, McpOperationMiddleware, MaybePromise } from "./operation.ts";

export interface McpErrorDetails {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
}

interface McpLifecycleEventBase<Context extends McpOperationContext> {
	readonly timestamp: number;
	readonly context: Context;
}

export interface McpOperationStartedEvent<
	Context extends McpOperationContext = McpOperationContext,
> extends McpLifecycleEventBase<Context> {
	readonly type: "operation.started";
}

export interface McpOperationSucceededEvent<
	Context extends McpOperationContext = McpOperationContext,
> extends McpLifecycleEventBase<Context> {
	readonly type: "operation.succeeded";
	readonly durationMs: number;
}

export interface McpOperationFailedEvent<
	Context extends McpOperationContext = McpOperationContext,
> extends McpLifecycleEventBase<Context> {
	readonly type: "operation.failed";
	readonly durationMs: number;
	readonly error: McpErrorDetails;
}

export interface McpOperationCancelledEvent<
	Context extends McpOperationContext = McpOperationContext,
> extends McpLifecycleEventBase<Context> {
	readonly type: "operation.cancelled";
	readonly durationMs: number;
	readonly error: McpErrorDetails;
}

/** Lifecycle events intentionally omit operation inputs and outputs to avoid payload leakage. */
export type McpLifecycleEvent<Context extends McpOperationContext = McpOperationContext> =
	| McpOperationStartedEvent<Context>
	| McpOperationSucceededEvent<Context>
	| McpOperationFailedEvent<Context>
	| McpOperationCancelledEvent<Context>;

/** Destination for structured runtime lifecycle events. */
export interface McpLifecycleObserver<Context extends McpOperationContext = McpOperationContext> {
	onEvent(event: McpLifecycleEvent<Context>): MaybePromise<void>;
}

export interface McpLifecycleMiddlewareOptions<
	Context extends McpOperationContext = McpOperationContext,
> {
	/** Unix epoch milliseconds. Injectable for deterministic tests and alternate clocks. */
	readonly now?: () => number;
	/** Observer failures never replace an operation result or error. */
	readonly onObserverError?: (
		error: unknown,
		event: McpLifecycleEvent<Context>,
	) => MaybePromise<void>;
}

/**
 * Fans out to a snapshot of observers. Every observer is attempted; once all
 * settle, one failure is rethrown directly and multiple failures as an
 * `AggregateError`.
 */
export function composeMcpLifecycleObservers<
	Context extends McpOperationContext = McpOperationContext,
>(observers: readonly McpLifecycleObserver<Context>[]): McpLifecycleObserver<Context> {
	const snapshot = observers.map((observer, index) => {
		if (typeof observer?.onEvent !== "function") {
			throw new TypeError(`observers[${String(index)}].onEvent must be a function.`);
		}
		return observer;
	});

	return Object.freeze({
		async onEvent(event: McpLifecycleEvent<Context>): Promise<void> {
			const settled = await Promise.allSettled(
				snapshot.map(async (observer) => observer.onEvent(event)),
			);
			const failures = settled
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason as unknown);

			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, "Multiple MCP lifecycle observers failed.");
			}
		},
	});
}

/**
 * Creates best-effort lifecycle instrumentation. Observer failures are reported
 * through `onObserverError` and never change the operation's result or primary
 * error. A rejected operation is classified as cancelled when its signal is
 * aborted at the point of rejection.
 */
export function createMcpLifecycleMiddleware<
	Input,
	Output,
	Context extends McpOperationContext = McpOperationContext,
>(
	observer: McpLifecycleObserver<Context>,
	options: McpLifecycleMiddlewareOptions<Context> = {},
): McpOperationMiddleware<Input, Output, Context> {
	if (typeof observer?.onEvent !== "function") {
		throw new TypeError("observer.onEvent must be a function.");
	}
	const now = options.now ?? Date.now;

	return async (operation, next) => {
		const startedAt = readTimestamp(now);
		await emitSafely(
			observer,
			Object.freeze({
				type: "operation.started",
				timestamp: startedAt,
				context: operation.context,
			}),
			options.onObserverError,
		);

		try {
			const output = await next();
			const finishedAt = readTimestamp(now);
			await emitSafely(
				observer,
				Object.freeze({
					type: "operation.succeeded",
					timestamp: finishedAt,
					durationMs: duration(startedAt, finishedAt),
					context: operation.context,
				}),
				options.onObserverError,
			);
			return output;
		} catch (error) {
			const finishedAt = readTimestamp(now);
			const event = Object.freeze({
				type: operation.context.signal.aborted
					? ("operation.cancelled" as const)
					: ("operation.failed" as const),
				timestamp: finishedAt,
				durationMs: duration(startedAt, finishedAt),
				context: operation.context,
				error: toMcpErrorDetails(error),
			}) satisfies McpOperationCancelledEvent<Context> | McpOperationFailedEvent<Context>;
			await emitSafely(observer, event, options.onObserverError);
			throw error;
		}
	};
}

/** Converts an unknown throwable into a small, serializable telemetry shape. */
export function toMcpErrorDetails(error: unknown): McpErrorDetails {
	if (error instanceof Error) {
		return Object.freeze({
			name: error.name || "Error",
			message: error.message,
			...readErrorCode(error),
		});
	}

	if (typeof error === "string") {
		return Object.freeze({ name: "Error", message: error });
	}

	return Object.freeze({
		name: "UnknownError",
		message: safeString(error),
		...readErrorCode(error),
	});
}

async function emitSafely<Context extends McpOperationContext>(
	observer: McpLifecycleObserver<Context>,
	event: McpLifecycleEvent<Context>,
	onObserverError:
		((error: unknown, event: McpLifecycleEvent<Context>) => MaybePromise<void>) | undefined,
): Promise<void> {
	try {
		await observer.onEvent(event);
	} catch (error) {
		if (onObserverError === undefined) return;
		try {
			await onObserverError(error, event);
		} catch {
			// Observability must not replace the operation result or its primary error.
		}
	}
}

function readTimestamp(now: () => number): number {
	try {
		const timestamp = now();
		if (Number.isFinite(timestamp)) return timestamp;
	} catch {
		// A telemetry clock is instrumentation and must not alter the operation.
	}
	try {
		const fallback = Date.now();
		if (Number.isFinite(fallback)) return fallback;
	} catch {
		// Extremely defensive fallback for a hostile or patched global clock.
	}
	return 0;
}

function duration(startedAt: number, finishedAt: number): number {
	return Math.max(0, finishedAt - startedAt);
}

function readErrorCode(error: unknown): { readonly code?: string } {
	if (typeof error !== "object" || error === null) return {};
	try {
		const code = (error as { readonly code?: unknown }).code;
		if (typeof code === "string" || typeof code === "number") {
			return { code: String(code) };
		}
	} catch {
		// A hostile getter should not make telemetry serialization fail.
	}
	return {};
}

function safeString(value: unknown): string {
	try {
		return String(value);
	} catch {
		return "Unknown thrown value";
	}
}
