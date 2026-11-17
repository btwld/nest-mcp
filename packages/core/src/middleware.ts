import type {
	MaybePromise,
	McpOperation,
	McpOperationContext,
	McpOperationHandler,
	McpOperationMiddleware,
	McpOperationNext,
} from "./operation.ts";

export const MCP_MIDDLEWARE_REENTRY = "MCP_MIDDLEWARE_REENTRY" as const;

/** Raised when middleware invokes its continuation more than once. */
export class McpMiddlewareReentryError extends Error {
	readonly code = MCP_MIDDLEWARE_REENTRY;
	readonly middlewareIndex: number;

	constructor(middlewareIndex: number) {
		super(`MCP middleware at index ${String(middlewareIndex)} called next() more than once.`);
		this.name = "McpMiddlewareReentryError";
		this.middlewareIndex = middlewareIndex;
	}
}

/**
 * Result-opaque middleware for logging, tracing, rate limits, and other
 * concerns that must not replace a protocol result.
 *
 * The continuation deliberately resolves to `void`. The adapter retains the
 * downstream value and returns that exact value after the middleware settles.
 */
export type McpPassthroughMiddleware<
	Input = unknown,
	Context extends McpOperationContext = McpOperationContext,
> = (operation: McpOperation<Input, Context>, next: McpOperationNext<void>) => MaybePromise<void>;

/**
 * Adapts result-opaque middleware to the regular transforming middleware
 * contract while guaranteeing that successful downstream results and errors
 * cannot be silently substituted or swallowed.
 */
export function createMcpPassthroughMiddleware<
	Input,
	Output,
	Context extends McpOperationContext = McpOperationContext,
>(
	middleware: McpPassthroughMiddleware<Input, Context>,
): McpOperationMiddleware<Input, Output, Context> {
	if (typeof middleware !== "function") {
		throw new TypeError("passthrough middleware must be a function.");
	}

	return async (operation, next) => {
		const continuation: { task?: Promise<Output> } = {};
		await middleware(operation, async () => {
			const task = next();
			continuation.task = task;
			await task;
		});

		const task = continuation.task;
		if (task === undefined) {
			throw new TypeError("Passthrough MCP middleware must call next().");
		}
		return task;
	};
}

/**
 * Composes middleware around a terminal handler. The input list is snapshotted
 * and each invocation gets an independent re-entry guard, so a reused pipeline
 * remains safe under concurrency.
 */
export function composeMcpMiddleware<
	Input,
	Output,
	Context extends McpOperationContext = McpOperationContext,
>(
	middleware: readonly McpOperationMiddleware<Input, Output, Context>[],
	terminal: McpOperationHandler<Input, Output, Context>,
): (operation: Parameters<McpOperationHandler<Input, Output, Context>>[0]) => Promise<Output> {
	if (typeof terminal !== "function") {
		throw new TypeError("terminal must be a function.");
	}

	const chain = middleware.map((entry, index) => {
		if (typeof entry !== "function") {
			throw new TypeError(`middleware[${String(index)}] must be a function.`);
		}
		return entry;
	});

	return async (operation) => {
		let highestDispatchedIndex = -1;

		const dispatch = async (index: number): Promise<Output> => {
			if (index <= highestDispatchedIndex) {
				throw new McpMiddlewareReentryError(Math.max(0, index - 1));
			}
			highestDispatchedIndex = index;

			const current = chain[index];
			if (current === undefined) return terminal(operation);
			return current(operation, () => dispatch(index + 1));
		};

		return dispatch(0);
	};
}
