import type { CallToolResult } from "@nest-mcp/server";

import {
	createMcpGatewayPassthroughMiddleware,
	defineMcpGatewayTransform,
	type McpGatewayDiscoverySnapshot,
	type McpGatewayInvocationOperationInput,
	type McpGatewayOperationOutputFor,
} from "../src/index.ts";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;

type InvocationOutput = McpGatewayOperationOutputFor<McpGatewayInvocationOperationInput>;

/** Proves the operation discriminator selects the invocation result contract. */
export type InvocationOutputIsCallToolResult = AssertTrue<
	IsAssignable<InvocationOutput, CallToolResult>
>;

/** Proves discovery output cannot cross the invocation discriminator boundary. */
export type InvocationOutputRejectsDiscovery = AssertFalse<
	IsAssignable<McpGatewayDiscoverySnapshot, InvocationOutput>
>;

createMcpGatewayPassthroughMiddleware(async (_operation, next) => {
	await next();
});

// @ts-expect-error Passthrough middleware cannot replace a discriminator-specific result.
createMcpGatewayPassthroughMiddleware(async () => ({ content: [] }));

defineMcpGatewayTransform("gateway.invocation", async (operation, next) => {
	const toolName: string = operation.input.toolName;
	// @ts-expect-error Detached tool definitions are deeply readonly.
	operation.input.tool.inputSchema.type = "string";
	if (operation.input.arguments !== undefined) {
		// @ts-expect-error Detached invocation arguments are deeply readonly.
		operation.input.arguments.tenant = "mutated";
	}
	const result: CallToolResult = await next();
	void toolName;
	void result.content;
	void result.structuredContent;
	void result["_meta"];
	return result;
});

defineMcpGatewayTransform("gateway.invocation", async (operation, next) => {
	// @ts-expect-error Invocation input does not expose completion params.
	void operation.input.params;
	return next();
});

// @ts-expect-error A discovery snapshot cannot replace a gateway invocation result.
defineMcpGatewayTransform("gateway.invocation", async () => ({
	tools: [],
	prompts: [],
	resources: [],
	resourceTemplates: [],
}));

declare const dynamicGatewayKind: "gateway.discovery" | "gateway.invocation";

// @ts-expect-error A union-valued runtime kind cannot preserve one exact input/result correlation.
defineMcpGatewayTransform(dynamicGatewayKind, async (_operation, next) => next());
