import type { McpServer } from "@modelcontextprotocol/server";
import type { McpServerFeature } from "@nest-mcp/server";
import type { ResourceOptions, ToolOptions } from "@nest-mcp/nestjs";
import {
	assertMcpAppResourceLinks,
	createMcpAppResourceContent,
	createMcpAppResourceFragment,
	createMcpAppsFeature,
	createMcpAppTextFallback,
	createMcpAppToolFragment,
} from "../src/index.ts";
import type {
	CreateMcpAppResourceContentOptions,
	McpAppResourceContent20260126,
	McpAppResourceFragment20260126,
	McpAppResourceUri,
	McpAppToolFragment20260126,
	McpAppToolVisibility20260126,
} from "../src/index.ts";

const RESOURCE_URI = "ui://weather/current" as const;

const toolFragment = createMcpAppToolFragment({
	resourceUri: RESOURCE_URI,
	visibility: ["model", "app"],
});
const resourceFragment = createMcpAppResourceFragment({
	csp: { connectDomains: ["https://api.example.com"] },
});
const resourceContent = createMcpAppResourceContent({
	uri: RESOURCE_URI,
	text: "<!doctype html><title>Weather</title>",
});

// These are the adapter seam: plain fragments, not decorators or browser bridge classes.
toolFragment satisfies McpAppToolFragment20260126;
resourceFragment satisfies McpAppResourceFragment20260126;
resourceContent satisfies McpAppResourceContent20260126;
const adapterResourceUri: typeof RESOURCE_URI = toolFragment["_meta"].ui.resourceUri;
const adapterVisibility: readonly McpAppToolVisibility20260126[] =
	toolFragment["_meta"].ui.visibility;
const adapterContentUri: typeof RESOURCE_URI = resourceContent.uri;
const adapterContentText: string = resourceContent.text;

function forwardResourceContent(options: CreateMcpAppResourceContentOptions) {
	return createMcpAppResourceContent(options);
}

const forwardedResourceContent = forwardResourceContent({
	uri: RESOURCE_URI,
	text: "<!doctype html><title>Forwarded</title>",
});

const nestToolOptions = {
	name: "weather-current",
	description: "Show current weather.",
	...toolFragment,
} satisfies ToolOptions;
const nestResourceOptions = {
	name: "weather-view",
	uri: RESOURCE_URI,
	...resourceFragment,
} satisfies ResourceOptions<typeof RESOURCE_URI>;

assertMcpAppResourceLinks([nestToolOptions], [nestResourceOptions]);

const feature: McpServerFeature = createMcpAppsFeature((server) => {
	registerNative(server);
});

function registerNative(server: McpServer): void {
	server.registerTool(
		"weather-current",
		{ description: "Show current weather.", ...toolFragment },
		async () => createMcpAppTextFallback("Current temperature: 21 °C."),
	);
	server.registerResource("weather-view", RESOURCE_URI, resourceFragment, async () => ({
		contents: [resourceContent],
	}));
}

const validUri: McpAppResourceUri = RESOURCE_URI;
// @ts-expect-error Apps resource types reject other schemes at compile time.
const invalidUri: McpAppResourceUri = "https://example.com/view";

void feature;
void invalidUri;
void adapterResourceUri;
void adapterVisibility;
void adapterContentUri;
void adapterContentText;
void forwardedResourceContent;
void nestResourceOptions;
void nestToolOptions;
void validUri;
