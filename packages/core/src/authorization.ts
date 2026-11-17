import type {
	McpOperation,
	McpOperationContext,
	McpOperationMiddleware,
	MaybePromise,
} from "./operation.ts";
import { copyMcpAttributes } from "./attribute-values.ts";
import type { McpAttributes } from "./attribute-values.ts";

export const MCP_AUTHORIZATION_DENIED = "MCP_AUTHORIZATION_DENIED" as const;

export interface McpAuthorizationAllowDecision {
	readonly effect: "allow";
	readonly policy?: string;
	readonly reason?: string;
	readonly attributes: McpAttributes;
}

export interface McpAuthorizationDenyDecision {
	readonly effect: "deny";
	readonly policy?: string;
	readonly reason: string;
	readonly attributes: McpAttributes;
}

/** Explicit authorization result. Missing or malformed results are never treated as allow. */
export type McpAuthorizationDecision = McpAuthorizationAllowDecision | McpAuthorizationDenyDecision;

/** Framework-neutral policy evaluated against the complete operation envelope. */
export interface McpAuthorizationPolicy<
	Input = unknown,
	Context extends McpOperationContext = McpOperationContext,
> {
	authorize(operation: McpOperation<Input, Context>): MaybePromise<McpAuthorizationDecision>;
}

export interface McpAuthorizationDecisionInit {
	readonly policy?: string;
	readonly reason?: string;
	readonly attributes?: McpAttributes;
}

export type McpAuthorizationFailure =
	"denied" | "missing-policy" | "invalid-decision" | "policy-error";

/** Fail-closed error raised before a denied operation reaches its terminal handler. */
export class McpAuthorizationError extends Error {
	readonly code = MCP_AUTHORIZATION_DENIED;
	readonly failure: McpAuthorizationFailure;
	readonly operationId: string;
	readonly decision: McpAuthorizationDenyDecision;

	constructor(
		operation: McpOperation,
		decision: McpAuthorizationDenyDecision,
		failure: McpAuthorizationFailure,
		options?: ErrorOptions,
	) {
		super("MCP operation authorization was denied.", options);
		this.name = "McpAuthorizationError";
		this.failure = failure;
		this.operationId = operation.context.operationId;
		this.decision = decision;
	}
}

/** Constructs a frozen allow decision. */
export function allowMcpOperation(
	init: McpAuthorizationDecisionInit = {},
): McpAuthorizationAllowDecision {
	assertOptionalNonEmpty(init.policy, "policy");
	assertOptionalNonEmpty(init.reason, "reason");
	return Object.freeze({
		effect: "allow",
		...(init.policy === undefined ? {} : { policy: init.policy }),
		...(init.reason === undefined ? {} : { reason: init.reason }),
		attributes: copyMcpAttributes(init.attributes),
	});
}

/** Constructs a frozen deny decision with a required, non-empty reason. */
export function denyMcpOperation(
	reason: string,
	init: Omit<McpAuthorizationDecisionInit, "reason"> = {},
): McpAuthorizationDenyDecision {
	assertNonEmpty(reason, "reason");
	assertOptionalNonEmpty(init.policy, "policy");
	return Object.freeze({
		effect: "deny",
		...(init.policy === undefined ? {} : { policy: init.policy }),
		reason,
		attributes: copyMcpAttributes(init.attributes),
	});
}

/**
 * Evaluates a policy and returns only an explicit allow. A missing policy,
 * policy exception, malformed result, or deny decision raises
 * `McpAuthorizationError` and therefore fails closed.
 */
export async function enforceMcpAuthorization<
	Input,
	Context extends McpOperationContext = McpOperationContext,
>(
	policy: McpAuthorizationPolicy<Input, Context> | undefined,
	operation: McpOperation<Input, Context>,
): Promise<McpAuthorizationAllowDecision> {
	if (policy === undefined) {
		throw authorizationError(
			operation,
			denyMcpOperation("No authorization policy is configured."),
			"missing-policy",
		);
	}

	let decision: unknown;
	try {
		decision = await policy.authorize(operation);
	} catch (cause) {
		throw authorizationError(
			operation,
			denyMcpOperation("The authorization policy failed."),
			"policy-error",
			{ cause },
		);
	}

	let normalizedDecision: McpAuthorizationDecision | undefined;
	try {
		normalizedDecision = normalizeAuthorizationDecision(decision);
	} catch (cause) {
		throw authorizationError(
			operation,
			denyMcpOperation("The authorization policy returned an invalid decision."),
			"invalid-decision",
			{ cause },
		);
	}

	if (normalizedDecision === undefined) {
		throw authorizationError(
			operation,
			denyMcpOperation("The authorization policy returned an invalid decision."),
			"invalid-decision",
		);
	}

	if (normalizedDecision.effect === "deny") {
		throw authorizationError(operation, normalizedDecision, "denied");
	}

	return normalizedDecision;
}

/** Creates middleware that enforces authorization before invoking the next stage. */
export function createMcpAuthorizationMiddleware<
	Input,
	Output,
	Context extends McpOperationContext = McpOperationContext,
>(
	policy: McpAuthorizationPolicy<Input, Context> | undefined,
): McpOperationMiddleware<Input, Output, Context> {
	return async (operation, next) => {
		await enforceMcpAuthorization(policy, operation);
		return next();
	};
}

function normalizeAuthorizationDecision(value: unknown): McpAuthorizationDecision | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<McpAuthorizationDecision>;
	if (candidate.effect !== "allow" && candidate.effect !== "deny") return undefined;
	if (!isAttributes(candidate.attributes)) return undefined;
	if (!isOptionalNonEmpty(candidate.policy)) return undefined;
	if (candidate.effect === "deny") {
		if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
			return undefined;
		}
		return denyMcpOperation(candidate.reason, {
			...(candidate.policy === undefined ? {} : { policy: candidate.policy }),
			attributes: candidate.attributes,
		});
	}
	if (!isOptionalNonEmpty(candidate.reason)) return undefined;
	return allowMcpOperation({
		...(candidate.policy === undefined ? {} : { policy: candidate.policy }),
		...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
		attributes: candidate.attributes,
	});
}

function authorizationError<Input, Context extends McpOperationContext>(
	operation: McpOperation<Input, Context>,
	decision: McpAuthorizationDenyDecision,
	failure: McpAuthorizationFailure,
	options?: ErrorOptions,
): McpAuthorizationError {
	return new McpAuthorizationError(operation, decision, failure, options);
}

function isAttributes(value: unknown): value is McpAttributes {
	try {
		copyMcpAttributes(value);
		return true;
	} catch {
		return false;
	}
}

function isOptionalNonEmpty(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}

function assertOptionalNonEmpty(value: string | undefined, field: string): void {
	if (value !== undefined) assertNonEmpty(value, field);
}
