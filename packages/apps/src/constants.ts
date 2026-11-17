/** Stable MCP Apps specification implemented by this package. */
export const MCP_APPS_SPEC_VERSION = "2026-01-26" as const;

/** SEP-2133 extension identifier used in client and server capability maps. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui" as const;

/** Required MIME type for HTML returned by an MCP Apps `ui://` resource. */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app" as const;

/**
 * Deprecated flat tool metadata key retained for compatibility with older hosts.
 * New consumers should read `_meta.ui.resourceUri`.
 */
export const MCP_APP_RESOURCE_URI_META_KEY = "ui/resourceUri" as const;

/** Stable-spec default when `_meta.ui.visibility` is omitted. */
export const MCP_APP_DEFAULT_TOOL_VISIBILITY = Object.freeze(["model", "app"] as const);
