import type { Prompt, Resource, Tool } from "@modelcontextprotocol/server";
import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@nest-mcp/server";
import type {
	McpGatewayCallToolOptions,
	McpGatewayClientRequestOptions,
	McpGatewayToolClient,
} from "../mcp-gateway.types.ts";

export type McpGatewayTestToolHandler = (
	arguments_: Readonly<Record<string, unknown>> | undefined,
) => CallToolResult | PromiseLike<CallToolResult>;

export interface McpGatewayTestClientOptions {
	readonly prompts?: readonly Prompt[];
	readonly resources?: readonly Resource[];
	readonly promptHandlers?: Readonly<
		Record<
			string,
			(
				arguments_: Readonly<Record<string, string>> | undefined,
			) => GetPromptResult | PromiseLike<GetPromptResult>
		>
	>;
	readonly resourceHandlers?: Readonly<
		Record<string, () => ReadResourceResult | PromiseLike<ReadResourceResult>>
	>;
}

/** Small deterministic upstream client for gateway unit and integration tests. */
export class McpGatewayTestClient implements McpGatewayToolClient {
	readonly calls: Array<{
		readonly name: string;
		readonly arguments?: Readonly<Record<string, unknown>>;
	}> = [];
	readonly promptCalls: Array<{
		readonly name: string;
		readonly arguments?: Readonly<Record<string, string>>;
	}> = [];
	readonly resourceReads: string[] = [];

	readonly #tools: readonly Tool[];
	readonly #handlers: Readonly<Record<string, McpGatewayTestToolHandler>>;
	readonly #options: McpGatewayTestClientOptions;

	constructor(
		tools: readonly Tool[],
		handlers: Readonly<Record<string, McpGatewayTestToolHandler>> = {},
		options: McpGatewayTestClientOptions = {},
	) {
		this.#tools = tools;
		this.#handlers = handlers;
		this.#options = options;
	}

	listPrompts(): { readonly prompts: readonly Prompt[] } {
		return { prompts: this.#options.prompts ?? [] };
	}

	async getPrompt(params: {
		readonly name: string;
		readonly arguments?: Readonly<Record<string, string>>;
	}): Promise<GetPromptResult> {
		this.promptCalls.push(Object.freeze({ ...params }));
		const handler = this.#options.promptHandlers?.[params.name];
		return handler === undefined ? { messages: [] } : handler(params.arguments);
	}

	listResources(): { readonly resources: readonly Resource[] } {
		return { resources: this.#options.resources ?? [] };
	}

	async readResource(params: { readonly uri: string }): Promise<ReadResourceResult> {
		this.resourceReads.push(params.uri);
		const handler = this.#options.resourceHandlers?.[params.uri];
		return handler === undefined ? { contents: [] } : handler();
	}

	listTools(
		_params?: { readonly cursor?: string },
		_options?: McpGatewayClientRequestOptions,
	): { readonly tools: readonly Tool[] } {
		return { tools: this.#tools };
	}

	async callTool(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, unknown>>;
		},
		_options?: McpGatewayCallToolOptions,
	): Promise<CallToolResult> {
		this.calls.push(Object.freeze({ ...params }));
		const handler = this.#handlers[params.name];
		if (handler === undefined) {
			return {
				content: [{ type: "text", text: `Called ${params.name}` }],
			};
		}
		return handler(params.arguments);
	}
}
