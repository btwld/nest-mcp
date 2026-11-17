import { createMcpOperationContext } from "@nest-mcp/core";
import type { McpOperationMetadata } from "@nest-mcp/core";
import type { McpServerPrincipal } from "@nest-mcp/server";

import type {
	McpGatewayOperationContext,
	McpGatewayOperationInput,
	McpGatewayPolicyInput,
	McpGatewayPrincipal,
	McpGatewayPromptPolicyInput,
	McpGatewayResolvedRequestContext,
	McpGatewayResourcePolicyInput,
	McpGatewayResourceTemplatePolicyInput,
} from "./mcp-gateway.types.ts";

type GatewayPolicyInput =
	| McpGatewayPolicyInput
	| McpGatewayPromptPolicyInput
	| McpGatewayResourcePolicyInput
	| McpGatewayResourceTemplatePolicyInput;

/** Creates the payload-safe context used by gateway execution middleware. */
export function createGatewayOperationContext(
	input: McpGatewayOperationInput,
	context: McpGatewayResolvedRequestContext,
): McpGatewayOperationContext {
	return createMcpOperationContext({
		operationId: operationId(context, input.type),
		role: "gateway",
		operation: operationMetadata(input),
		signal: context.signal,
		...(context.requestId === undefined ? {} : { requestId: context.requestId }),
		...gatewayPrincipalContext(context),
		...(context.attributes === undefined ? {} : { attributes: context.attributes }),
	});
}

/** Creates the separate context used by mandatory gateway policy checks. */
export function createGatewayPolicyContext(
	input: GatewayPolicyInput,
	context: McpGatewayResolvedRequestContext,
): McpGatewayOperationContext {
	const capability =
		"toolName" in input ? "tools" : "promptName" in input ? "prompts" : "resources";
	return createMcpOperationContext({
		operationId: operationId(context, `policy.${input.action}`),
		role: "gateway",
		operation: {
			name: `${capability}/${input.action}.authorize`,
			kind: "request",
			capability,
			target: input.upstreamName,
			attributes: {
				"gateway.policy.action": input.action,
				"mcp.server.name": input.upstreamName,
				...(capability === "tools" ? { "gen_ai.tool.name": input.projectedName } : {}),
				...(capability === "prompts" ? { "mcp.prompt.name": input.projectedName } : {}),
				...(capability === "resources" ? { "mcp.resource.name": input.projectedName } : {}),
			},
		},
		signal: context.signal,
		...(context.requestId === undefined ? {} : { requestId: context.requestId }),
		...gatewayPrincipalContext(context),
		...(context.attributes === undefined ? {} : { attributes: context.attributes }),
	});
}

/** Copies only the stable, credential-free principal dimensions. */
export function toSafeGatewayPrincipal(
	identity: McpServerPrincipal | NonNullable<McpGatewayResolvedRequestContext["authInfo"]>,
): McpGatewayPrincipal {
	const resource =
		identity.resource === undefined
			? undefined
			: typeof identity.resource === "string"
				? identity.resource
				: identity.resource.href;
	return Object.freeze({
		clientId: identity.clientId,
		scopes: Object.freeze([...identity.scopes]),
		...(identity.expiresAt === undefined ? {} : { expiresAt: identity.expiresAt }),
		...(resource === undefined ? {} : { resource }),
		...("subject" in identity && identity.subject !== undefined
			? { subject: identity.subject }
			: {}),
		...("tenantId" in identity && identity.tenantId !== undefined
			? { tenantId: identity.tenantId }
			: {}),
	});
}

function operationMetadata(input: McpGatewayOperationInput): McpOperationMetadata {
	const common = {
		kind: "request" as const,
		target: input.upstreamName,
		attributes: {
			"gateway.operation": input.type,
			"mcp.server.name": input.upstreamName,
		},
	};
	switch (input.type) {
		case "gateway.discovery": {
			const capability = input.capability ?? "tools";
			return { ...common, name: `${capability}/list`, capability };
		}
		case "gateway.invocation":
			return {
				...common,
				name: "tools/call",
				capability: "tools",
				attributes: { ...common.attributes, "gen_ai.tool.name": input.projectedName },
			};
		case "gateway.prompt.get":
			return {
				...common,
				name: "prompts/get",
				capability: "prompts",
				attributes: { ...common.attributes, "mcp.prompt.name": input.projectedName },
			};
		case "gateway.resource.read":
			return {
				...common,
				name: "resources/read",
				capability: "resources",
				attributes: { ...common.attributes, "mcp.resource.name": input.projectedName },
			};
		case "gateway.resource-template.read":
			return {
				...common,
				name: "resources/read",
				capability: "resources",
				attributes: {
					...common.attributes,
					"mcp.resource.name": input.projectedName,
				},
			};
		case "gateway.completion":
			return {
				...common,
				name: "completion/complete",
				capability: "completions",
				attributes: {
					...common.attributes,
					"mcp.completion.reference": input.projectedIdentifier,
				},
			};
		default:
			return assertNever(input);
	}
}

function operationId(context: McpGatewayResolvedRequestContext, suffix: string): string {
	return `${context.requestId ?? crypto.randomUUID()}:${suffix}:${crypto.randomUUID()}`;
}

function gatewayPrincipalContext(
	context: McpGatewayResolvedRequestContext,
): Readonly<{ principal?: McpGatewayPrincipal }> {
	if (context.principal !== undefined) {
		return { principal: toSafeGatewayPrincipal(context.principal) };
	}
	if (context.authInfo !== undefined) {
		return { principal: toSafeGatewayPrincipal(context.authInfo) };
	}
	return {};
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected gateway operation input: ${String(value)}`);
}
