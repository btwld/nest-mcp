import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APP_RESOURCE_URI_META_KEY } from "./constants.ts";
import { McpAppsValidationError, McpAppsValidationErrorCode } from "./mcp-apps.errors.ts";
import {
	normalizeMcpAppResourceMimeType,
	normalizeMcpAppResourceUri,
	normalizeMcpAppToolMetadata,
} from "./normalization.ts";

/** Minimal structural tool definition consumed by link validation. */
export interface McpAppToolLinkCandidate {
	readonly name: string;
	readonly _meta?: unknown;
}

/** Minimal structural resource definition consumed by link validation. */
export interface McpAppResourceLinkCandidate {
	readonly uri: string;
	readonly mimeType?: unknown;
	readonly _meta?: unknown;
}

/**
 * Rejects App tool references that have no corresponding registered `ui://` resource.
 * Non-App tools and App-only tools without a resource URI are ignored.
 */
export function assertMcpAppResourceLinks(
	tools: readonly McpAppToolLinkCandidate[],
	resources: readonly McpAppResourceLinkCandidate[],
): void {
	const registeredResourceUris = new Set(
		resources.filter(isAppsResourceCandidate).map(({ uri, mimeType }) => {
			normalizeMcpAppResourceMimeType(mimeType);
			return normalizeMcpAppResourceUri(uri);
		}),
	);
	for (const tool of tools) {
		const metadata: unknown = Reflect.get(tool, "_meta");
		if (!hasAppsToolMetadata(metadata)) continue;
		const resourceUri = normalizeMcpAppToolMetadata(metadata, {
			includeDeprecatedResourceUri: false,
		}).ui.resourceUri;
		if (resourceUri === undefined || registeredResourceUris.has(resourceUri)) continue;
		throw new McpAppsValidationError(
			McpAppsValidationErrorCode.MissingResource,
			`tool ${JSON.stringify(tool.name)} resource link`,
			`no registered App resource matches ${JSON.stringify(resourceUri)}`,
		);
	}
}

function isAppsResourceCandidate(resource: McpAppResourceLinkCandidate): boolean {
	if (typeof resource.uri === "string" && resource.uri.startsWith("ui://")) return true;
	if (resource.mimeType === MCP_APP_RESOURCE_MIME_TYPE) return true;
	const metadata: unknown = Reflect.get(resource, "_meta");
	return (
		metadata !== null &&
		typeof metadata === "object" &&
		!Array.isArray(metadata) &&
		Object.hasOwn(metadata, "ui")
	);
}

function hasAppsToolMetadata(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.hasOwn(value, "ui") || Object.hasOwn(value, MCP_APP_RESOURCE_URI_META_KEY))
	);
}
