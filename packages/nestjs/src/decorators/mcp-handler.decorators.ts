import { SetMetadata } from "@nestjs/common";
import type {
	CacheHint,
	Icon,
	PromptCallback,
	ReadResourceCallback,
	ReadResourceTemplateCallback,
	ResourceMetadata,
	ResourceTemplate,
	StandardSchemaWithJSON,
	ToolAnnotations,
	ToolCallback,
} from "@nest-mcp/server";
import type { McpCapabilityVisibility } from "../mcp-capability.types.ts";
import { MCP_HANDLER_METADATA, MCP_TARGETS_METADATA } from "../mcp.tokens.ts";

interface HandlerTarget {
	/** Runtime names receiving this handler. Omit for every configured server. */
	readonly servers?: string | readonly string[];
	/** Discovery visibility. Invocation authorization remains independently mandatory. */
	readonly visibility?: McpCapabilityVisibility;
}

export interface ToolOptions<
	InputSchema extends StandardSchemaWithJSON | undefined = StandardSchemaWithJSON | undefined,
> extends HandlerTarget {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema?: InputSchema;
	readonly outputSchema?: StandardSchemaWithJSON;
	readonly annotations?: ToolAnnotations;
	readonly icons?: Icon[];
	readonly _meta?: Record<string, unknown>;
	/** Searchable application labels used only by Nest MCP catalog selectors. */
	readonly tags?: readonly string[];
}

export interface ResourceOptions<
	Uri extends string | ResourceTemplate = string | ResourceTemplate,
> extends HandlerTarget {
	readonly name: string;
	readonly uri: Uri;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
	readonly icons?: Icon[];
	readonly annotations?: ResourceMetadata["annotations"];
	readonly _meta?: Record<string, unknown>;
	readonly cacheHint?: CacheHint;
}

export interface PromptOptions<
	ArgsSchema extends StandardSchemaWithJSON | undefined = StandardSchemaWithJSON | undefined,
> extends HandlerTarget {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly argsSchema?: ArgsSchema;
	readonly icons?: Icon[];
	readonly _meta?: Record<string, unknown>;
}

export interface ToolHandlerDefinition {
	readonly kind: "tool";
	readonly options: ToolOptions;
}

export interface ResourceHandlerDefinition {
	readonly kind: "resource";
	readonly options: ResourceOptions;
}

export interface PromptHandlerDefinition {
	readonly kind: "prompt";
	readonly options: PromptOptions;
}

export type HandlerDefinition =
	ToolHandlerDefinition | ResourceHandlerDefinition | PromptHandlerDefinition;

/** Legacy-decorator signature that checks the decorated method without replacing it. */
export type TypedMethodDecorator<ExpectedHandler> = <Handler extends ExpectedHandler>(
	target: object,
	propertyKey: string | symbol,
	descriptor: TypedPropertyDescriptor<Handler>,
) => void;

export type ToolMethodDecorator<InputSchema extends StandardSchemaWithJSON | undefined> =
	TypedMethodDecorator<ToolCallback<InputSchema>>;

export type PromptMethodDecorator<ArgsSchema extends StandardSchemaWithJSON | undefined> =
	TypedMethodDecorator<PromptCallback<ArgsSchema>>;

export type ResourceMethodDecorator<Uri extends string | ResourceTemplate> = TypedMethodDecorator<
	Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback
>;

export function Tool<const InputSchema extends StandardSchemaWithJSON | undefined = undefined>(
	options: ToolOptions<InputSchema>,
): ToolMethodDecorator<InputSchema> {
	return typedMetadataDecorator(freezeToolDefinition(options));
}

export function Resource<const Uri extends string | ResourceTemplate>(
	options: ResourceOptions<Uri>,
): ResourceMethodDecorator<Uri> {
	return typedMetadataDecorator(freezeResourceDefinition(options));
}

export function Prompt<const ArgsSchema extends StandardSchemaWithJSON | undefined = undefined>(
	options: PromptOptions<ArgsSchema>,
): PromptMethodDecorator<ArgsSchema> {
	return typedMetadataDecorator(freezePromptDefinition(options));
}

/** Supplies a default server target for every MCP handler declared by a provider class. */
export function Targets(...serverNames: readonly [string, ...string[]]): ClassDecorator {
	const normalized = normalizeTargets(serverNames);
	return SetMetadata(MCP_TARGETS_METADATA, normalized);
}

function typedMetadataDecorator<Handler>(
	definition: HandlerDefinition,
): TypedMethodDecorator<Handler> {
	const decorator = SetMetadata(MCP_HANDLER_METADATA, definition);
	return (target, propertyKey, descriptor) => {
		decorator(target, propertyKey, descriptor);
	};
}

function freezeToolDefinition(options: ToolOptions): ToolHandlerDefinition {
	const { tags, ...sdkOptions } = options;
	const normalizedTags = normalizeTags(tags);
	return Object.freeze({
		kind: "tool",
		options: freezeOptions({
			...sdkOptions,
			...(normalizedTags === undefined ? {} : { tags: normalizedTags }),
		}),
	});
}

function freezeResourceDefinition(options: ResourceOptions): ResourceHandlerDefinition {
	return Object.freeze({ kind: "resource", options: freezeOptions(options) });
}

function freezePromptDefinition(options: PromptOptions): PromptHandlerDefinition {
	return Object.freeze({ kind: "prompt", options: freezeOptions(options) });
}

function freezeOptions<Options extends HandlerTarget>(options: Options): Options {
	const servers = options.servers;
	const normalizedServers =
		servers === undefined
			? undefined
			: typeof servers === "string"
				? normalizeTargets([servers])[0]
				: normalizeTargets(servers);
	return Object.freeze({
		...options,
		...(normalizedServers === undefined ? {} : { servers: normalizedServers }),
	});
}

function normalizeTargets(serverNames: readonly string[]): readonly string[] {
	if (serverNames.length === 0) {
		throw new TypeError("At least one MCP server target is required.");
	}
	const normalized = serverNames.map((serverName, index) => {
		if (typeof serverName !== "string" || serverName.trim().length === 0) {
			throw new TypeError(`MCP target at index ${String(index)} must be a non-empty string.`);
		}
		return serverName.trim();
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new TypeError("MCP class-level targets must not contain duplicates.");
	}
	return Object.freeze(normalized);
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] | undefined {
	if (tags === undefined) return undefined;
	if (!Array.isArray(tags) || tags.length > 32) {
		throw new TypeError("MCP tool tags must be an array containing at most 32 entries.");
	}
	const normalized = tags.map((tag, index) => {
		if (typeof tag !== "string" || tag.trim().length === 0 || tag.trim().length > 64) {
			throw new TypeError(
				`MCP tool tag at index ${String(index)} must contain between 1 and 64 characters.`,
			);
		}
		return tag.trim();
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new TypeError("MCP tool tags must not contain duplicates.");
	}
	return Object.freeze(normalized);
}
