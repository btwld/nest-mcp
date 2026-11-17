import { copyMcpAttributes } from "./attribute-values.ts";
import type { McpAttributeScalar, McpAttributes, McpAttributeValue } from "./attribute-values.ts";

export type { McpAttributeScalar, McpAttributes, McpAttributeValue };

/** A value that may be produced synchronously or asynchronously. */
export type MaybePromise<Value> = Value | PromiseLike<Value>;

/** The position at which an operation is running. */
export type McpRuntimeRole = "client" | "server" | "gateway";

/** The protocol interaction represented by an operation. */
export type McpOperationKind = "request" | "notification";

/** Stable metadata describing an operation independently of its input payload. */
export interface McpOperationMetadata {
	/** Protocol method or application-defined operation name. */
	readonly name: string;
	readonly kind: McpOperationKind;
	/** Optional capability family, such as `tools`, `resources`, or `prompts`. */
	readonly capability?: string;
	/** Optional logical target, such as an upstream server identifier. */
	readonly target?: string;
	readonly attributes: McpAttributes;
}

/** Immutable context propagated through one runtime operation. */
export interface McpOperationContext<Principal = unknown> {
	/** Runtime-unique identifier used to correlate logs and telemetry. */
	readonly operationId: string;
	readonly role: McpRuntimeRole;
	readonly operation: McpOperationMetadata;
	readonly signal: AbortSignal;
	readonly requestId?: string;
	readonly sessionId?: string;
	readonly principal?: Principal;
	readonly attributes: McpAttributes;
}

/** Input used to construct an immutable operation context. */
export interface McpOperationContextInit<Principal = unknown> {
	readonly operationId: string;
	readonly role: McpRuntimeRole;
	readonly operation: Omit<McpOperationMetadata, "attributes"> & {
		readonly attributes?: McpAttributes;
	};
	readonly signal?: AbortSignal;
	readonly requestId?: string;
	readonly sessionId?: string;
	readonly principal?: Principal;
	readonly attributes?: McpAttributes;
}

/** An input payload paired with the context propagated through its execution. */
export interface McpOperation<
	Input = unknown,
	Context extends McpOperationContext = McpOperationContext,
> {
	readonly input: Input;
	readonly context: Context;
}

/** The terminal function at the end of an operation middleware chain. */
export type McpOperationHandler<
	Input = unknown,
	Output = unknown,
	Context extends McpOperationContext = McpOperationContext,
> = (operation: McpOperation<Input, Context>) => MaybePromise<Output>;

/** Continuation supplied to operation middleware. It may be invoked at most once. */
export type McpOperationNext<Output = unknown> = () => Promise<Output>;

/** Middleware that surrounds the next stage of an operation. */
export type McpOperationMiddleware<
	Input = unknown,
	Output = unknown,
	Context extends McpOperationContext = McpOperationContext,
> = (
	operation: McpOperation<Input, Context>,
	next: McpOperationNext<Output>,
) => MaybePromise<Output>;

/**
 * Creates a shallowly immutable context and copies both attribute maps so later
 * caller mutation cannot alter routing, authorization, or telemetry dimensions.
 */
export function createMcpOperationContext<Principal = unknown>(
	init: McpOperationContextInit<Principal>,
): McpOperationContext<Principal> {
	assertIdentifier(init.operationId, "operationId");
	assertRuntimeRole(init.role);
	assertIdentifier(init.operation.name, "operation.name");
	assertOperationKind(init.operation.kind);
	assertOptionalIdentifier(init.operation.capability, "operation.capability");
	assertOptionalIdentifier(init.operation.target, "operation.target");
	assertOptionalIdentifier(init.requestId, "requestId");
	assertOptionalIdentifier(init.sessionId, "sessionId");

	const operation = Object.freeze({
		name: init.operation.name,
		kind: init.operation.kind,
		...(init.operation.capability === undefined ? {} : { capability: init.operation.capability }),
		...(init.operation.target === undefined ? {} : { target: init.operation.target }),
		attributes: copyMcpAttributes(init.operation.attributes, "operation.attributes"),
	}) satisfies McpOperationMetadata;

	const context = {
		operationId: init.operationId,
		role: init.role,
		operation,
		signal: init.signal ?? new AbortController().signal,
		...(init.requestId === undefined ? {} : { requestId: init.requestId }),
		...(init.sessionId === undefined ? {} : { sessionId: init.sessionId }),
		...(init.principal === undefined ? {} : { principal: init.principal }),
		attributes: copyMcpAttributes(init.attributes, "attributes"),
	} satisfies McpOperationContext<Principal>;

	return Object.freeze(context);
}

/** Creates an immutable operation envelope without cloning its potentially large input. */
export function createMcpOperation<
	Input,
	Context extends McpOperationContext = McpOperationContext,
>(input: Input, context: Context): McpOperation<Input, Context> {
	return Object.freeze({ input, context });
}

function assertRuntimeRole(role: McpRuntimeRole): void {
	if (role !== "client" && role !== "server" && role !== "gateway") {
		throw new TypeError("role must be client, server, or gateway.");
	}
}

function assertOperationKind(kind: McpOperationKind): void {
	if (kind !== "request" && kind !== "notification") {
		throw new TypeError("operation.kind must be request or notification.");
	}
}

function assertIdentifier(value: string, field: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}

function assertOptionalIdentifier(value: string | undefined, field: string): void {
	if (value !== undefined) assertIdentifier(value, field);
}
