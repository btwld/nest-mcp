import type { RequestMethod } from "@modelcontextprotocol/client";
import {
	createMcpPassthroughMiddleware,
	type McpOperation,
	type McpOperationNext,
} from "@nest-mcp/core";

import { hasExactMcpClientResult } from "./exact-result-profile.ts";
import type {
	McpClientMiddleware,
	McpClientOperationContext,
	McpClientOperationInput,
	McpClientPassthroughMiddleware,
	McpClientRequestMethod,
	McpClientTransform,
	McpClientTransformInput,
	McpClientTransformResult,
} from "./types.ts";

const exactClientTransforms = new WeakSet<object>();

type SingleValueConstraint<Value, Whole = Value> = Value extends unknown
	? [Whole] extends [Value]
		? unknown
		: never
	: never;

/**
 * Defines a transform for one ordinary official request/result pair.
 *
 * Runtime-owned custom-schema, manual-MRTR, input-required, and managed
 * subscription operations are intentionally not dispatched to this helper,
 * even when they share the same protocol method string.
 */
export function defineMcpClientTransform<
	const Method extends McpClientRequestMethod,
	Principal = unknown,
>(
	method: Method & SingleValueConstraint<Method>,
	transform: McpClientTransform<Method, Principal>,
): McpClientMiddleware<Principal> {
	assertRequestMethod(method);
	if (typeof transform !== "function") {
		throw new TypeError("client transform must be a function.");
	}

	const middleware: McpClientMiddleware<Principal> = async (operation, next) => {
		if (!isExactRequestOperation<Method, Principal>(operation, method)) return next();

		operation.context.signal.throwIfAborted();
		// This adapter is the sole bridge from the intentionally result-erased
		// shared chain to the runtime-owned exact-result profile above.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const exactNext = next as McpOperationNext<McpClientTransformResult<Method>>;
		const result = await transform(operation, exactNext);
		operation.context.signal.throwIfAborted();
		return result;
	};
	exactClientTransforms.add(middleware);
	return middleware;
}

/** @internal Runtime partitioning keeps exact continuations downstream of broad middleware. */
export function isExactMcpClientTransform<Principal>(
	middleware: McpClientMiddleware<Principal>,
): boolean {
	return exactClientTransforms.has(middleware);
}

/**
 * Binds provider-owned middleware without erasing exact-transform identity.
 *
 * Exact transforms carry runtime-only identity used to keep their typed
 * continuation behind broad middleware. Since `Function.bind()` creates a new
 * function, exact transforms must remain unchanged; their defining adapter
 * already closes over the supplied transform callback.
 */
export function bindMcpClientMiddleware<Principal>(
	middleware: McpClientMiddleware<Principal>,
	receiver: object,
): McpClientMiddleware<Principal> {
	return isExactMcpClientTransform(middleware) ? middleware : middleware.bind(receiver);
}

/**
 * Creates client middleware that always returns the exact downstream result.
 * The callback can run before and after `next()`, but cannot inspect, replace,
 * or swallow a method-specific result.
 */
export function createMcpClientPassthroughMiddleware<Principal = unknown>(
	middleware: McpClientPassthroughMiddleware<Principal>,
): McpClientMiddleware<Principal> {
	return createMcpPassthroughMiddleware<
		McpClientOperationInput,
		unknown,
		McpClientOperationContext<Principal>
	>(middleware);
}

function isExactRequestOperation<Method extends McpClientRequestMethod, Principal>(
	operation: McpOperation<McpClientOperationInput, McpClientOperationContext<Principal>>,
	method: Method,
): operation is McpOperation<
	McpClientTransformInput<Method>,
	McpClientOperationContext<Principal>
> {
	return (
		operation.input.method === method &&
		operation.context.operation.kind === "request" &&
		operation.context.operation.name === method &&
		hasExactMcpClientResult(operation.input, method)
	);
}

function assertRequestMethod(method: RequestMethod): void {
	if (typeof method !== "string" || method.trim().length === 0) {
		throw new TypeError("client transform method must be a non-empty string.");
	}
}
