import type { StandardSchemaWithJSON } from "@modelcontextprotocol/client";
import type { ZodType } from "zod/v4";

import type {
	CallToolResult,
	GetPromptResult,
	InputRequiredResult,
	McpClientProtocolRequest,
	McpClientRuntime,
	McpClientTransformOptions,
	McpClientTool,
	McpClientToolInputSchema,
	McpClientToolOutputSchema,
	McpClientToolSchemaIssue,
	McpClientToolSchemaResult,
	McpClientToolStandardSchema,
	ReadResourceResult,
} from "../src/index.ts";
import { createMcpClientPassthroughMiddleware, createMcpClientToolSchema } from "../src/index.ts";
import { defineMcpClientTransform } from "../src/index.ts";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type AssertFalse<Value extends false> = Value;

const discoveredTool = {
	name: "echo",
	inputSchema: { type: "object", properties: { value: { type: "string" } } },
	outputSchema: { type: "object", properties: { value: { type: "string" } } },
} satisfies McpClientTool;
const discoveredInputSchema: McpClientToolInputSchema = discoveredTool.inputSchema;
const discoveredOutputSchema: McpClientToolOutputSchema = discoveredTool.outputSchema;

void discoveredInputSchema;
void discoveredOutputSchema;

const portableToolSchema = createMcpClientToolSchema(discoveredTool.inputSchema);
const zodToolSchema: ZodType = portableToolSchema;
const standardToolSchema: StandardSchemaWithJSON = portableToolSchema;
const legacyStandardToolSchema: McpClientToolStandardSchema = portableToolSchema;
const legacyToolSchemaIssue: McpClientToolSchemaIssue = { message: "invalid" };
const legacyToolSchemaResult: McpClientToolSchemaResult = { issues: [legacyToolSchemaIssue] };
const legacyValidation: Promise<McpClientToolSchemaResult> = portableToolSchema[
	"~standard"
].validate({});
const legacyProjection: Record<string, unknown> = portableToolSchema["~standard"].jsonSchema.input(
	{},
);

void zodToolSchema;
void standardToolSchema;
void legacyStandardToolSchema;
void legacyToolSchemaResult;
void legacyValidation;
void legacyProjection;

type MismatchedResourceRequest = {
	readonly method: "resources/read";
	readonly params: { readonly name: "not-a-resource-uri" };
};

/** Proves the default public union retains the method/params correlation. */
export type ProtocolRequestRejectsMismatchedParams = AssertFalse<
	IsAssignable<MismatchedResourceRequest, McpClientProtocolRequest>
>;

/** Proves an explicitly unioned method parameter stays a discriminated union. */
export type ProtocolRequestUnionRejectsMismatchedParams = AssertFalse<
	IsAssignable<MismatchedResourceRequest, McpClientProtocolRequest<"resources/read" | "tools/call">>
>;

declare const runtime: McpClientRuntime;

const completeToolResult = runtime.callTool("upstream", { name: "echo" });
const manualToolResult = runtime.callTool(
	"upstream",
	{ name: "echo" },
	{ allowInputRequired: true },
);
const manualPromptResult = runtime.getPrompt(
	"upstream",
	{ name: "review" },
	{ allowInputRequired: true },
);
const manualResourceResult = runtime.readResource(
	"upstream",
	{ uri: "docs://guide" },
	{ allowInputRequired: true },
);
const manualGenericToolResult = runtime.request(
	"upstream",
	{ method: "tools/call", params: { name: "echo" } },
	{ allowInputRequired: true },
);

/** Proves normal tool calls retain the official complete-result contract. */
export type CallToolCompleteResult = AssertFalse<
	IsAssignable<InputRequiredResult, Awaited<typeof completeToolResult>>
>;

/** Proves manual tool calls expose the continuation in their public result. */
export type CallToolManualResult = AssertFalse<
	IsAssignable<
		Awaited<typeof manualToolResult>,
		Exclude<CallToolResult | InputRequiredResult, InputRequiredResult>
	>
>;

/** Proves every MRTR-capable high-level helper exposes an explicit continuation. */
export type PromptManualResult = AssertFalse<
	IsAssignable<
		Awaited<typeof manualPromptResult>,
		Exclude<GetPromptResult | InputRequiredResult, InputRequiredResult>
	>
>;
export type ResourceManualResult = AssertFalse<
	IsAssignable<
		Awaited<typeof manualResourceResult>,
		Exclude<ReadResourceResult | InputRequiredResult, InputRequiredResult>
	>
>;
export type GenericManualToolResult = AssertFalse<
	IsAssignable<
		Awaited<typeof manualGenericToolResult>,
		Exclude<CallToolResult | InputRequiredResult, InputRequiredResult>
	>
>;

export function protocolRequestCompileTests(): void {
	void runtime.request("upstream", {
		method: "resources/read",
		// @ts-expect-error resources/read requires params.uri, never tools/call-style params.name.
		params: { name: "not-a-resource-uri" },
	});
}

createMcpClientPassthroughMiddleware(async (_operation, next) => {
	await next();
});

// @ts-expect-error Passthrough middleware cannot replace a method-specific client result.
createMcpClientPassthroughMiddleware(async () => ({ tools: [] }));

defineMcpClientTransform("tools/call", async (operation, next) => {
	const toolName: string = operation.input.params.name;
	const toolDefinition = operation.input.options?.toolDefinition;
	// @ts-expect-error Detached transform params are deeply readonly.
	operation.input.params.name = "mutated";
	if (operation.input.options !== undefined) {
		// @ts-expect-error Transform request options are readonly.
		operation.input.options.timeout = 1;
	}
	if (toolDefinition?.inputSchema !== undefined) {
		// @ts-expect-error Detached tool definitions are deeply readonly.
		toolDefinition.inputSchema.type = "string";
	}
	const result: CallToolResult = await next();
	void toolName;
	void toolDefinition?.outputSchema;
	void result.content;
	void result.structuredContent;
	void result["_meta"];
	return result;
});

defineMcpClientTransform("tools/call", async (operation, next) => {
	// @ts-expect-error tools/call input has params.name, not resources/read params.uri.
	void operation.input.params.uri;
	return next();
});

// @ts-expect-error A tools/list result cannot replace a tools/call result.
defineMcpClientTransform("tools/call", async () => ({ tools: [] }));

declare const dynamicClientMethod: "tools/call" | "tools/list";

// @ts-expect-error A union-valued runtime method cannot preserve one exact input/result correlation.
defineMcpClientTransform(dynamicClientMethod, async (_operation, next) => next());

const invalidExactOptions: McpClientTransformOptions<"tools/call"> = {
	// @ts-expect-error Exact-result tool transforms exclude manual input-required mode.
	allowInputRequired: true,
};

void invalidExactOptions;
