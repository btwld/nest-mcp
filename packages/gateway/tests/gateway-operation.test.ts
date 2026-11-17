import type { AuthInfo } from "@nest-mcp/server";
import { describe, expect, it } from "vitest";

import {
	createGatewayOperationContext,
	createGatewayPolicyContext,
} from "../src/gateway-operation.ts";
import type {
	McpGatewayDiscoveryOperationInput,
	McpGatewayPromptPolicyInput,
	McpGatewayResolvedRequestContext,
} from "../src/mcp-gateway.types.ts";

const authInfo = {
	token: "must-not-leak",
	clientId: "client-a",
	scopes: ["prompts:read"],
	expiresAt: 2_000_000_000,
	resource: new URL("https://gateway.example.test/mcp"),
} satisfies AuthInfo;

const resolvedContext = {
	authorizationContext: "principal-a",
	signal: new AbortController().signal,
	requestId: "request-a",
	authInfo,
	attributes: { tenant: "acme" },
} satisfies McpGatewayResolvedRequestContext;

describe("gateway operation context", () => {
	it("maps execution discriminators to stable metadata without exposing credentials", () => {
		const input = {
			type: "gateway.discovery",
			upstreamName: "upstream-a",
			capability: "prompts",
		} satisfies McpGatewayDiscoveryOperationInput;

		const context = createGatewayOperationContext(input, resolvedContext);

		expect(context).toMatchObject({
			role: "gateway",
			requestId: "request-a",
			operation: {
				name: "prompts/list",
				kind: "request",
				capability: "prompts",
				target: "upstream-a",
				attributes: {
					"gateway.operation": "gateway.discovery",
					"mcp.server.name": "upstream-a",
				},
			},
			principal: {
				clientId: "client-a",
				scopes: ["prompts:read"],
				expiresAt: 2_000_000_000,
				resource: "https://gateway.example.test/mcp",
			},
			attributes: { tenant: "acme" },
		});
		expect(context.operationId).toMatch(/^request-a:gateway\.discovery:/);
		expect(context).not.toHaveProperty("authInfo");
		expect(context.principal).not.toHaveProperty("token");
	});

	it("keeps policy checks in their own operation namespace", () => {
		const input = {
			action: "get",
			upstreamName: "upstream-a",
			promptName: "welcome",
			projectedName: "gw:welcome",
			prompt: { name: "welcome" },
		} satisfies McpGatewayPromptPolicyInput;

		const context = createGatewayPolicyContext(input, resolvedContext);

		expect(context.operation).toEqual({
			name: "prompts/get.authorize",
			kind: "request",
			capability: "prompts",
			target: "upstream-a",
			attributes: {
				"gateway.policy.action": "get",
				"mcp.server.name": "upstream-a",
				"mcp.prompt.name": "gw:welcome",
			},
		});
		expect(context.operationId).toMatch(/^request-a:policy\.get:/);
	});
});
