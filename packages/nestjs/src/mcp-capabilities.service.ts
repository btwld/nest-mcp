import { Injectable } from "@nestjs/common";
import type {
	PromptCallback,
	ReadResourceCallback,
	ReadResourceTemplateCallback,
	ResourceTemplate,
	StandardSchemaWithJSON,
	ToolCallback,
} from "@nest-mcp/server";
import type {
	McpCapabilityDescriptor,
	McpCapabilityMutationObserver,
	McpDynamicHandlerRegistration,
} from "./mcp-capability.types.ts";
import type {
	PromptOptions,
	ResourceOptions,
	ToolOptions,
} from "./decorators/mcp-handler.decorators.ts";
import { McpHandlerRegistry } from "./discovery/mcp-handler.registry.ts";

/** Public Nest service for live capability registration after application bootstrap. */
@Injectable()
export class McpCapabilitiesService {
	constructor(private readonly registry: McpHandlerRegistry) {}

	list(): readonly McpCapabilityDescriptor[] {
		return this.registry.list();
	}

	registerTool<const InputSchema extends StandardSchemaWithJSON | undefined = undefined>(
		options: ToolOptions<InputSchema>,
		handler: ToolCallback<InputSchema>,
		source?: string,
	): McpDynamicHandlerRegistration<ToolCallback<InputSchema>> {
		return this.registry.registerTool(options, handler, source);
	}

	registerPrompt<const ArgsSchema extends StandardSchemaWithJSON | undefined = undefined>(
		options: PromptOptions<ArgsSchema>,
		handler: PromptCallback<ArgsSchema>,
		source?: string,
	): McpDynamicHandlerRegistration<PromptCallback<ArgsSchema>> {
		return this.registry.registerPrompt(options, handler, source);
	}

	registerResource<const Uri extends string | ResourceTemplate>(
		options: ResourceOptions<Uri>,
		handler: Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback,
		source?: string,
	): McpDynamicHandlerRegistration<
		Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback
	> {
		return this.registry.registerResource(options, handler, source);
	}

	onMutation(observer: McpCapabilityMutationObserver): () => void {
		return this.registry.onMutation(observer);
	}
}
