import type {
	CallToolResult,
	CompleteRequest,
	GetPromptResult,
	InputRequiredResult,
	JsonSchemaType,
	ReadResourceResult,
	StandardSchemaWithJSON,
	Tool,
} from "@modelcontextprotocol/server";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { isInputRequiredResult, specTypeSchemas } from "@nest-mcp/client";
import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type {
	McpGatewayCallToolOptions,
	McpGatewayClientRequestOptions,
	McpGatewayClientRuntime,
	McpGatewayToolClient,
	McpGatewayUpstream,
} from "./mcp-gateway.types.ts";

/**
 * Adapts one named server in `@nest-mcp/client` to a gateway upstream.
 * `gatewayName` may alias the runtime's server name without changing its connection registry.
 */
export function createMcpClientRuntimeUpstream(
	runtime: McpGatewayClientRuntime,
	serverName: string,
	gatewayName = serverName,
): McpGatewayUpstream {
	assertNonEmpty(serverName, "serverName");
	assertNonEmpty(gatewayName, "gatewayName");
	const baseClient = Object.freeze({
		listTools: (params?: { readonly cursor?: string }, options?: McpGatewayClientRequestOptions) =>
			runtime.request(serverName, { method: "tools/list", params: params ?? {} }, options),
		callTool: async (
			params: {
				readonly name: string;
				readonly arguments?: Readonly<Record<string, unknown>>;
			},
			options?: McpGatewayCallToolOptions,
		) => {
			const outputValidator = compileOutputValidator(options?.toolDefinition, gatewayName);
			const result = requireCompleteResult(
				await runtime.callTool(serverName, params, {
					allowInputRequired: true,
					...(options?.signal === undefined ? {} : { signal: options.signal }),
					...(options?.toolDefinition === undefined
						? {}
						: { toolDefinition: withoutOutputSchema(options.toolDefinition) }),
				}),
				gatewayName,
				"tools/call",
			);
			await validateToolOutput(result, outputValidator, gatewayName, params.name);
			return result;
		},
	});
	return Object.freeze({
		name: gatewayName,
		client: () => {
			const capabilities = runtime.snapshot(serverName).serverCapabilities;
			const toolsExplicitlyUnsupported =
				capabilities !== undefined && capabilities.tools === undefined;
			return Object.freeze({
				...(toolsExplicitlyUnsupported
					? {
							listTools: async () => ({ tools: [] }),
							callTool: async () => {
								throw new McpGatewayError(
									"UNSUPPORTED_UPSTREAM_CAPABILITY",
									`Upstream "${gatewayName}" does not advertise the tools capability.`,
								);
							},
						}
					: baseClient),
				getServerCapabilities: () => capabilities,
				...(capabilities?.prompts === undefined
					? {}
					: {
							listPrompts: (
								params?: { readonly cursor?: string },
								options?: McpGatewayClientRequestOptions,
							) =>
								runtime.request(
									serverName,
									{ method: "prompts/list", params: params ?? {} },
									options,
								),
							getPrompt: async (
								params: {
									readonly name: string;
									readonly arguments?: Readonly<Record<string, string>>;
								},
								options?: McpGatewayClientRequestOptions,
							) =>
								requireCompleteResult(
									await runtime.requestWithInputRequired(
										serverName,
										{ method: "prompts/get", params },
										specTypeSchemas.GetPromptResult,
										options,
									),
									gatewayName,
									"prompts/get",
								),
						}),
				...(capabilities?.resources === undefined
					? {}
					: {
							listResources: (
								params?: { readonly cursor?: string },
								options?: McpGatewayClientRequestOptions,
							) =>
								runtime.request(
									serverName,
									{ method: "resources/list", params: params ?? {} },
									options,
								),
							readResource: async (
								params: { readonly uri: string },
								options?: McpGatewayClientRequestOptions,
							) =>
								requireCompleteResult(
									await runtime.requestWithInputRequired(
										serverName,
										{ method: "resources/read", params },
										specTypeSchemas.ReadResourceResult,
										options,
									),
									gatewayName,
									"resources/read",
								),
							listResourceTemplates: (
								params?: { readonly cursor?: string },
								options?: McpGatewayClientRequestOptions,
							) =>
								runtime.request(
									serverName,
									{ method: "resources/templates/list", params: params ?? {} },
									options,
								),
						}),
				...(capabilities?.completions === undefined
					? {}
					: {
							complete: (
								params: CompleteRequest["params"],
								options?: McpGatewayClientRequestOptions,
							) => runtime.complete(serverName, params, options),
						}),
			}) satisfies McpGatewayToolClient;
		},
	}) satisfies McpGatewayUpstream;
}

/**
 * Keep `Client.callTool`'s SEP-2243 header preparation while preventing its
 * plain-result output validator from misclassifying a surfaced
 * `input_required` result. The original schema is compiled before invocation
 * and applied locally after the continuation union has been resolved.
 */
function compileOutputValidator(
	toolDefinition: Tool | undefined,
	upstreamName: string,
): StandardSchemaWithJSON<unknown, unknown> | undefined {
	if (toolDefinition?.outputSchema === undefined) return undefined;
	try {
		return fromJsonSchema(toJsonSchemaType(toolDefinition.outputSchema));
	} catch (cause) {
		throw new McpGatewayError(
			"INVALID_DISCOVERY",
			`Upstream "${upstreamName}" tool "${toolDefinition.name}" declares an output schema that cannot be compiled.`,
			{ cause },
		);
	}
}

function toJsonSchemaType(value: NonNullable<Tool["outputSchema"]>): JsonSchemaType {
	const { $schema, ...schema } = value;
	return $schema === undefined ? schema : { ...schema, $schema };
}

function withoutOutputSchema(toolDefinition: Tool): Tool {
	const { outputSchema: _outputSchema, ...manualDefinition } = toolDefinition;
	return manualDefinition;
}

async function validateToolOutput(
	result: CallToolResult,
	validator: StandardSchemaWithJSON<unknown, unknown> | undefined,
	upstreamName: string,
	toolName: string,
): Promise<void> {
	if (validator === undefined || result.isError === true) return;
	if (result.structuredContent === undefined) {
		throw new McpGatewayError(
			"INVALID_INVOCATION_RESULT",
			`Upstream "${upstreamName}" tool "${toolName}" has an output schema but returned no structured content.`,
		);
	}
	const validation = await validator["~standard"].validate(result.structuredContent);
	if (validation.issues !== undefined && validation.issues.length > 0) {
		throw new McpGatewayError(
			"INVALID_INVOCATION_RESULT",
			`Upstream "${upstreamName}" tool "${toolName}" returned structured content that does not match its output schema.`,
		);
	}
}

function requireCompleteResult(
	result: CallToolResult | InputRequiredResult,
	upstreamName: string,
	method: "tools/call",
): CallToolResult;
function requireCompleteResult(
	result: GetPromptResult | InputRequiredResult,
	upstreamName: string,
	method: "prompts/get",
): GetPromptResult;
function requireCompleteResult(
	result: InputRequiredResult | ReadResourceResult,
	upstreamName: string,
	method: "resources/read",
): ReadResourceResult;
function requireCompleteResult(
	result: CallToolResult | GetPromptResult | InputRequiredResult | ReadResourceResult,
	upstreamName: string,
	method: "prompts/get" | "resources/read" | "tools/call",
): CallToolResult | GetPromptResult | ReadResourceResult {
	if (isInputRequiredResult(result)) {
		throw new McpGatewayError(
			"UPSTREAM_INPUT_REQUIRED",
			`Upstream "${upstreamName}" returned input_required for ${method}; the gateway adapter deliberately uses manual mode and will not auto-fulfill it.`,
		);
	}
	return result;
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}
