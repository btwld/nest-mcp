import {
	createMcpPassthroughMiddleware,
	type McpOperation,
	type McpOperationNext,
} from "@nest-mcp/core";

import type {
	McpGatewayMiddleware,
	McpGatewayOperationContext,
	McpGatewayOperationInput,
	McpGatewayOperationInputFor,
	McpGatewayOperationKind,
	McpGatewayOperationOutput,
	McpGatewayOperationOutputForKind,
	McpGatewayPassthroughMiddleware,
	McpGatewayTransform,
} from "./mcp-gateway.types.ts";

const exactGatewayTransforms = new WeakSet<object>();

type SingleValueConstraint<Value, Whole = Value> = Value extends unknown
	? [Whole] extends [Value]
		? unknown
		: never
	: never;

/** Defines a transform for one exact gateway operation/result pair. */
export function defineMcpGatewayTransform<const Kind extends McpGatewayOperationKind>(
	kind: Kind & SingleValueConstraint<Kind>,
	transform: McpGatewayTransform<Kind>,
): McpGatewayMiddleware {
	assertOperationKind(kind);
	if (typeof transform !== "function") {
		throw new TypeError("gateway transform must be a function.");
	}

	const middleware: McpGatewayMiddleware = async (operation, next) => {
		if (!isOperationKind<Kind>(operation, kind)) return next();

		operation.context.signal.throwIfAborted();
		// The discriminator is the runtime proof that reconnects the exact
		// result to the intentionally unioned shared gateway chain.
		// The gateway snapshots and deep-freezes every operation input before
		// entering this chain, so the public transform receives its readonly view.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const exactOperation = operation as McpOperation<
			McpGatewayOperationInputFor<Kind>,
			McpGatewayOperationContext
		>;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const exactNext = next as McpOperationNext<McpGatewayOperationOutputForKind<Kind>>;
		const result = await transform(exactOperation, exactNext);
		operation.context.signal.throwIfAborted();
		return result;
	};
	exactGatewayTransforms.add(middleware);
	return middleware;
}

/** @internal Runtime partitioning keeps exact continuations downstream of broad middleware. */
export function isExactMcpGatewayTransform(middleware: McpGatewayMiddleware): boolean {
	return exactGatewayTransforms.has(middleware);
}

/**
 * Binds provider-owned middleware without erasing exact-transform identity.
 *
 * Exact transforms carry runtime-only identity used to keep their typed
 * continuation behind broad middleware. Since `Function.bind()` creates a new
 * function, exact transforms must remain unchanged; their defining adapter
 * already closes over the supplied transform callback.
 */
export function bindMcpGatewayMiddleware(
	middleware: McpGatewayMiddleware,
	receiver: object,
): McpGatewayMiddleware {
	return isExactMcpGatewayTransform(middleware) ? middleware : middleware.bind(receiver);
}

/**
 * Creates gateway middleware that returns the exact downstream result. The
 * callback can run before and after `next()`, but the result remains opaque so
 * it cannot accidentally cross operation-discriminator boundaries.
 */
export function createMcpGatewayPassthroughMiddleware(
	middleware: McpGatewayPassthroughMiddleware,
): McpGatewayMiddleware {
	return createMcpPassthroughMiddleware<
		McpGatewayOperationInput,
		McpGatewayOperationOutput,
		McpGatewayOperationContext
	>(middleware);
}

function isOperationKind<Kind extends McpGatewayOperationKind>(
	operation: McpOperation<McpGatewayOperationInput, McpGatewayOperationContext>,
	kind: Kind,
): operation is McpOperation<
	Extract<McpGatewayOperationInput, { readonly type: Kind }>,
	McpGatewayOperationContext
> {
	return operation.input.type === kind;
}

function assertOperationKind(kind: McpGatewayOperationKind): void {
	if (typeof kind !== "string" || kind.trim().length === 0) {
		throw new TypeError("gateway transform kind must be a non-empty string.");
	}
}
