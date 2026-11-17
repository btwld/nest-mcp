import type {
	ClientCapabilities,
	McpServer,
	ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { McpServerFeature } from "@nest-mcp/server";
import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APPS_EXTENSION_ID } from "./constants.ts";
import { normalizeMcpAppsClientCapability } from "./normalization.ts";
import type {
	McpAppsClientCapability20260126,
	McpAppsServerCapability20260126,
} from "./spec-2026-01-26.ts";

export interface McpAppsServerCapabilityFragment {
	readonly extensions: {
		readonly [MCP_APPS_EXTENSION_ID]: McpAppsServerCapability20260126;
	};
}

/** Exact server-side SEP-2133 advertisement. Client MIME settings do not belong here. */
export const MCP_APPS_SERVER_CAPABILITY = Object.freeze({
	extensions: Object.freeze({
		[MCP_APPS_EXTENSION_ID]: Object.freeze({}),
	}),
}) satisfies McpAppsServerCapabilityFragment;

/** Adds the Apps extension advertisement while preserving other server capabilities/extensions. */
export function withMcpAppsServerCapability(
	capabilities: ServerCapabilities = {},
): ServerCapabilities {
	return {
		...capabilities,
		extensions: {
			...capabilities.extensions,
			[MCP_APPS_EXTENSION_ID]: {},
		},
	};
}

/** Advertises Apps on an unconnected official split-v2 server instance. */
export function advertiseMcpApps(server: Pick<McpServer, "server">): void {
	server.server.registerCapabilities(MCP_APPS_SERVER_CAPABILITY);
}

/**
 * Creates a real `McpServerFeature`: it advertises Apps, then performs the
 * caller's ordinary official-v2 tool/resource registrations.
 */
export function createMcpAppsFeature(register?: McpServerFeature): McpServerFeature {
	return (server, context) => {
		advertiseMcpApps(server);
		return register?.(server, context);
	};
}

/** Reads and validates stable Apps client settings; malformed/untrusted settings are unsupported. */
export function getMcpAppsClientCapability(
	capabilities: Pick<ClientCapabilities, "extensions"> | null | undefined,
): McpAppsClientCapability20260126 | undefined {
	const value = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID];
	if (value === undefined) return undefined;
	try {
		return normalizeMcpAppsClientCapability(value);
	} catch {
		return undefined;
	}
}

/** True only when the client declared Apps and the exact stable HTML MIME type. */
export function clientSupportsMcpApps(
	capabilities: Pick<ClientCapabilities, "extensions"> | null | undefined,
): boolean {
	return (
		getMcpAppsClientCapability(capabilities)?.mimeTypes.includes(MCP_APP_RESOURCE_MIME_TYPE) ??
		false
	);
}
