import { MCP_APP_RESOURCE_MIME_TYPE } from "./constants.ts";
import { McpAppsValidationError, McpAppsValidationErrorCode } from "./mcp-apps.errors.ts";
import {
	normalizeMcpAppResourceMeta,
	normalizeMcpAppResourceMetadata,
	normalizeMcpAppResourceMimeType,
	normalizeMcpAppResourceUri,
	normalizeMcpAppToolMetadata,
	normalizeMcpAppToolVisibility,
} from "./normalization.ts";
import type {
	McpAppResourceContent20260126,
	McpAppBlobResourceContent20260126,
	McpAppResourceFragment20260126,
	McpAppResourceMeta20260126,
	McpAppResourceMetadata20260126,
	McpAppTextFallbackFragment,
	McpAppTextResourceContent20260126,
	McpAppToolFragment20260126,
	McpAppToolVisibility20260126,
} from "./spec-2026-01-26.ts";

export interface CreateMcpAppToolFragmentOptions<ResourceUri extends string = string> {
	readonly resourceUri: ResourceUri;
	readonly visibility?: readonly McpAppToolVisibility20260126[];
	/** Unrelated `_meta` entries to retain alongside the owned `ui` entry. */
	readonly metadata?: Readonly<Record<string, unknown>>;
	/** Defaults to `true` for older-host compatibility. */
	readonly includeDeprecatedResourceUri?: boolean;
}

export interface CreateMcpAppResourceFragmentOptions extends McpAppResourceMeta20260126 {
	/** Unrelated `_meta` entries to retain alongside the owned `ui` entry. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

interface CreateMcpAppResourceContentBase<
	ResourceUri extends string = string,
> extends CreateMcpAppResourceFragmentOptions {
	readonly uri: ResourceUri;
	readonly mimeType?: string;
}

export interface CreateMcpAppTextResourceContentOptions<
	ResourceUri extends string = string,
> extends CreateMcpAppResourceContentBase<ResourceUri> {
	readonly text: string;
	readonly blob?: never;
}

export interface CreateMcpAppBlobResourceContentOptions<
	ResourceUri extends string = string,
> extends CreateMcpAppResourceContentBase<ResourceUri> {
	readonly blob: string;
	readonly text?: never;
}

export type CreateMcpAppResourceContentOptions<ResourceUri extends string = string> =
	| CreateMcpAppTextResourceContentOptions<ResourceUri>
	| CreateMcpAppBlobResourceContentOptions<ResourceUri>;

/**
 * Creates a plain fragment accepted by both Nest `@Tool()` and the official v2
 * `McpServer.registerTool()` config object.
 */
export function createMcpAppToolFragment<const ResourceUri extends string>(
	options: CreateMcpAppToolFragmentOptions<ResourceUri>,
): McpAppToolFragment20260126<ResourceUri & `ui://${string}`> {
	const metadata = ownedMetadata(options.metadata, "tool");
	const resourceUri = normalizeMcpAppResourceUri(options.resourceUri);
	const visibility = normalizeMcpAppToolVisibility(options.visibility);
	const normalizedMetadata = normalizeMcpAppToolMetadata(
		{
			...metadata,
			ui: { resourceUri, visibility },
		},
		options.includeDeprecatedResourceUri === undefined
			? {}
			: { includeDeprecatedResourceUri: options.includeDeprecatedResourceUri },
	);
	return Object.freeze({
		_meta: Object.freeze({
			...normalizedMetadata,
			ui: Object.freeze({ ...normalizedMetadata.ui, resourceUri, visibility }),
		}),
	});
}

/**
 * Creates a plain fragment accepted by both Nest `@Resource()` and the official
 * v2 `McpServer.registerResource()` config object.
 */
export function createMcpAppResourceFragment(
	options: CreateMcpAppResourceFragmentOptions = {},
): McpAppResourceFragment20260126 {
	const resourceMetadata = createResourceMetadata(options);
	return Object.freeze({
		mimeType: MCP_APP_RESOURCE_MIME_TYPE,
		...(resourceMetadata === undefined ? {} : { _meta: resourceMetadata }),
	});
}

/** Builds a validated Apps `resources/read` envelope; HTML/base64 payload validity stays caller-owned. */
export function createMcpAppResourceContent<const ResourceUri extends string>(
	options: CreateMcpAppTextResourceContentOptions<ResourceUri>,
): McpAppTextResourceContent20260126<ResourceUri & `ui://${string}`>;
export function createMcpAppResourceContent<const ResourceUri extends string>(
	options: CreateMcpAppBlobResourceContentOptions<ResourceUri>,
): McpAppBlobResourceContent20260126<ResourceUri & `ui://${string}`>;
export function createMcpAppResourceContent<const ResourceUri extends string>(
	options: CreateMcpAppResourceContentOptions<ResourceUri>,
): McpAppResourceContent20260126<ResourceUri & `ui://${string}`>;
export function createMcpAppResourceContent(
	options: CreateMcpAppResourceContentOptions,
): McpAppResourceContent20260126 {
	const uri = normalizeMcpAppResourceUri(options.uri);
	const mimeType = normalizeMcpAppResourceMimeType(options.mimeType);
	const resourceMetadata = createResourceMetadata(options);
	const hasText = Object.hasOwn(options, "text");
	const hasBlob = Object.hasOwn(options, "blob");
	if (hasText === hasBlob) {
		throw new McpAppsValidationError(
			McpAppsValidationErrorCode.InvalidContent,
			"resource content",
			"expected exactly one of text or blob",
		);
	}
	const base = {
		uri,
		mimeType,
		...(resourceMetadata === undefined ? {} : { _meta: resourceMetadata }),
	};
	if (hasText) {
		if (typeof options.text !== "string") return invalidContent("text must be a string");
		return Object.freeze({ ...base, text: options.text });
	}
	if (typeof options.blob !== "string") return invalidContent("blob must be a base64 string");
	return Object.freeze({ ...base, blob: options.blob });
}

function createResourceMetadata(
	options: CreateMcpAppResourceFragmentOptions,
): McpAppResourceMetadata20260126 | undefined {
	const metadata = ownedMetadata(options.metadata, "resource");
	const ui = normalizeMcpAppResourceMeta(resourceMetaInput(options));
	const resourceMetadata = normalizeMcpAppResourceMetadata({
		...metadata,
		...(Object.keys(ui).length === 0 ? {} : { ui }),
	});
	return Object.keys(resourceMetadata).length === 0 ? undefined : resourceMetadata;
}

/** Creates the minimum meaningful text content that every App-enabled tool should return. */
export function createMcpAppTextFallback(text: string): McpAppTextFallbackFragment {
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new McpAppsValidationError(
			McpAppsValidationErrorCode.InvalidFallback,
			"tool text fallback",
			"expected non-empty text that is useful without an App-capable host",
		);
	}
	return { content: [{ type: "text", text }] };
}

function resourceMetaInput(
	options: CreateMcpAppResourceFragmentOptions,
): McpAppResourceMeta20260126 {
	return {
		...(options.csp === undefined ? {} : { csp: options.csp }),
		...(options.permissions === undefined ? {} : { permissions: options.permissions }),
		...(options.domain === undefined ? {} : { domain: options.domain }),
		...(options.prefersBorder === undefined ? {} : { prefersBorder: options.prefersBorder }),
	};
}

function ownedMetadata(
	value: Readonly<Record<string, unknown>> | undefined,
	kind: "tool" | "resource",
): Readonly<Record<string, unknown>> {
	const metadata = value ?? {};
	if (Object.hasOwn(metadata, "ui")) {
		throw new McpAppsValidationError(
			McpAppsValidationErrorCode.InvalidMetadata,
			`${kind} _meta.ui`,
			`createMcpApp${kind === "tool" ? "Tool" : "Resource"}Fragment owns the "ui" entry`,
		);
	}
	return metadata;
}

function invalidContent(detail: string): never {
	throw new McpAppsValidationError(
		McpAppsValidationErrorCode.InvalidContent,
		"resource content",
		detail,
	);
}
