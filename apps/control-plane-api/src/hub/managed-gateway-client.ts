import type { ServerCapabilities } from "@modelcontextprotocol/server";
import type {
	McpGatewayCallToolOptions,
	McpGatewayClientRequestOptions,
	McpGatewayListPromptsResult,
	McpGatewayListResourcesResult,
	McpGatewayListResourceTemplatesResult,
	McpGatewayListToolsResult,
	McpGatewayToolClient,
} from "@nest-mcp/gateway";
import type { McpRuntimeCatalogSnapshot, McpRuntimeManagerPort } from "@nest-mcp/manager";

/** Structural gateway client pinned to one admitted manager generation and catalog. */
export class ManagedGatewayClient implements McpGatewayToolClient {
	constructor(
		private readonly generationKey: string,
		private catalog: McpRuntimeCatalogSnapshot,
		private readonly manager: McpRuntimeManagerPort,
	) {}

	updateCatalog(catalog: McpRuntimeCatalogSnapshot): void {
		this.catalog = catalog;
	}

	getServerCapabilities(): ServerCapabilities | undefined {
		const capabilities = this.manager.state(this.generationKey).capabilities;
		if (capabilities === undefined) return undefined;
		return Object.freeze({
			...(capabilities.tools ? { tools: {} } : {}),
			...(capabilities.prompts ? { prompts: {} } : {}),
			...(capabilities.resources ? { resources: { subscribe: capabilities.subscriptions } } : {}),
			...(capabilities.completion ? { completions: {} } : {}),
		});
	}

	listTools(
		_params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): McpGatewayListToolsResult {
		options?.signal?.throwIfAborted();
		return Object.freeze({ tools: this.catalog.tools });
	}

	callTool(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, unknown>>;
		},
		options?: McpGatewayCallToolOptions,
	) {
		return this.manager.withClientRuntime(
			this.generationKey,
			({ runtime, serverName, signal }) =>
				runtime.callTool(serverName, params, {
					signal,
					allowInputRequired: true,
					...(options?.toolDefinition === undefined
						? {}
						: { toolDefinition: options.toolDefinition }),
				}),
			options?.signal,
		);
	}

	listPrompts(
		_params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): McpGatewayListPromptsResult {
		options?.signal?.throwIfAborted();
		return Object.freeze({ prompts: this.catalog.prompts });
	}

	getPrompt(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, string>>;
		},
		options?: McpGatewayClientRequestOptions,
	) {
		return this.manager.withClientRuntime(
			this.generationKey,
			({ runtime, serverName, signal }) =>
				runtime.getPrompt(serverName, params, { signal, allowInputRequired: true }),
			options?.signal,
		);
	}

	listResources(
		_params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): McpGatewayListResourcesResult {
		options?.signal?.throwIfAborted();
		return Object.freeze({ resources: this.catalog.resources });
	}

	readResource(params: { readonly uri: string }, options?: McpGatewayClientRequestOptions) {
		return this.manager.withClientRuntime(
			this.generationKey,
			({ runtime, serverName, signal }) =>
				runtime.readResource(serverName, params, {
					signal,
					allowInputRequired: true,
				}),
			options?.signal,
		);
	}

	listResourceTemplates(
		_params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): McpGatewayListResourceTemplatesResult {
		options?.signal?.throwIfAborted();
		return Object.freeze({ resourceTemplates: this.catalog.resourceTemplates });
	}
}
