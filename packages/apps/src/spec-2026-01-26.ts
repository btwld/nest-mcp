import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APP_RESOURCE_URI_META_KEY } from "./constants.ts";

/** A resource URI using the exact scheme required by the stable MCP Apps specification. */
export type McpAppResourceUri = `ui://${string}`;

export type McpAppToolVisibility20260126 = "model" | "app";

/** Stable 2026-01-26 `_meta.ui` shape for tools. */
export interface McpAppToolMeta20260126 {
	readonly resourceUri?: McpAppResourceUri;
	readonly visibility?: readonly McpAppToolVisibility20260126[];
	/** CSP belongs on the UI resource, never the tool. */
	readonly csp?: never;
	/** Permission requests belong on the UI resource, never the tool. */
	readonly permissions?: never;
}

/** Stable 2026-01-26 Content Security Policy inputs for UI resources. */
export interface McpAppResourceCsp20260126 {
	readonly connectDomains?: readonly string[];
	readonly resourceDomains?: readonly string[];
	readonly frameDomains?: readonly string[];
	readonly baseUriDomains?: readonly string[];
}

/** The stable specification represents each requested permission with an empty object. */
export type McpAppPermissionRequest20260126 = Readonly<Record<string, never>>;

/** Stable 2026-01-26 iframe permission requests for UI resources. */
export interface McpAppResourcePermissions20260126 {
	readonly camera?: McpAppPermissionRequest20260126;
	readonly microphone?: McpAppPermissionRequest20260126;
	readonly geolocation?: McpAppPermissionRequest20260126;
	readonly clipboardWrite?: McpAppPermissionRequest20260126;
}

/** Stable 2026-01-26 `_meta.ui` shape for resource declarations and contents. */
export interface McpAppResourceMeta20260126 {
	readonly csp?: McpAppResourceCsp20260126;
	readonly permissions?: McpAppResourcePermissions20260126;
	/** Host-specific dedicated sandbox origin. */
	readonly domain?: string;
	readonly prefersBorder?: boolean;
}

/** Tool `_meta` envelope. Unrelated extension metadata is preserved. */
export interface McpAppToolMetadata20260126 {
	readonly ui: McpAppToolMeta20260126;
	/** @deprecated Use `ui.resourceUri`. */
	readonly [MCP_APP_RESOURCE_URI_META_KEY]?: McpAppResourceUri;
	readonly [key: string]: unknown;
}

/** Resource `_meta` envelope. Unrelated extension metadata is preserved. */
export interface McpAppResourceMetadata20260126 {
	readonly ui?: McpAppResourceMeta20260126;
	readonly [key: string]: unknown;
}

/** Decorator/native registration fragment for an App-enabled tool. */
export interface McpAppToolFragment20260126<
	ResourceUri extends McpAppResourceUri = McpAppResourceUri,
> {
	readonly _meta: McpAppToolMetadata20260126 & {
		readonly ui: McpAppToolMeta20260126 & {
			readonly resourceUri: ResourceUri;
			readonly visibility: readonly McpAppToolVisibility20260126[];
		};
	};
}

/** Decorator/native registration fragment for an App HTML resource. */
export interface McpAppResourceFragment20260126 {
	readonly mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
	readonly _meta?: McpAppResourceMetadata20260126;
}

interface McpAppResourceContentBase20260126<
	ResourceUri extends McpAppResourceUri = McpAppResourceUri,
> {
	readonly uri: ResourceUri;
	readonly mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
	readonly _meta?: McpAppResourceMetadata20260126;
}

export type McpAppTextResourceContent20260126<
	ResourceUri extends McpAppResourceUri = McpAppResourceUri,
> = McpAppResourceContentBase20260126<ResourceUri> & {
	readonly text: string;
	readonly blob?: never;
};

export type McpAppBlobResourceContent20260126<
	ResourceUri extends McpAppResourceUri = McpAppResourceUri,
> = McpAppResourceContentBase20260126<ResourceUri> & {
	readonly blob: string;
	readonly text?: never;
};

/** Exact stable resource-content union: HTML text or base64 blob, never both. */
export type McpAppResourceContent20260126<
	ResourceUri extends McpAppResourceUri = McpAppResourceUri,
> = McpAppTextResourceContent20260126<ResourceUri> | McpAppBlobResourceContent20260126<ResourceUri>;

/** Client extension settings required to negotiate the stable HTML resource format. */
export interface McpAppsClientCapability20260126 {
	readonly mimeTypes: readonly string[];
	readonly [key: string]: unknown;
}

/** Server settings are empty; MIME types are advertised by clients, not servers. */
export type McpAppsServerCapability20260126 = Readonly<Record<string, never>>;

/** Small result fragment for a useful text/model fallback. */
export interface McpAppTextFallbackFragment {
	readonly [key: string]: unknown;
	content: [{ type: "text"; text: string }];
}

// Unsuffixed names track the current stable Apps specification. Date-suffixed names remain fixed.
export type McpAppToolVisibility = McpAppToolVisibility20260126;
export type McpAppToolMeta = McpAppToolMeta20260126;
export type McpAppResourceCsp = McpAppResourceCsp20260126;
export type McpAppPermissionRequest = McpAppPermissionRequest20260126;
export type McpAppResourcePermissions = McpAppResourcePermissions20260126;
export type McpAppResourceMeta = McpAppResourceMeta20260126;
export type McpAppToolMetadata = McpAppToolMetadata20260126;
export type McpAppResourceMetadata = McpAppResourceMetadata20260126;
export type McpAppToolFragment<ResourceUri extends McpAppResourceUri = McpAppResourceUri> =
	McpAppToolFragment20260126<ResourceUri>;
export type McpAppResourceFragment = McpAppResourceFragment20260126;
export type McpAppTextResourceContent<ResourceUri extends McpAppResourceUri = McpAppResourceUri> =
	McpAppTextResourceContent20260126<ResourceUri>;
export type McpAppBlobResourceContent<ResourceUri extends McpAppResourceUri = McpAppResourceUri> =
	McpAppBlobResourceContent20260126<ResourceUri>;
export type McpAppResourceContent<ResourceUri extends McpAppResourceUri = McpAppResourceUri> =
	McpAppResourceContent20260126<ResourceUri>;
export type McpAppsClientCapability = McpAppsClientCapability20260126;
export type McpAppsServerCapability = McpAppsServerCapability20260126;
