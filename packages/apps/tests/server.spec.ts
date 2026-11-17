import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { McpServerRuntime } from "@nest-mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MCP_APP_RESOURCE_MIME_TYPE,
	MCP_APPS_EXTENSION_ID,
	MCP_APPS_SERVER_CAPABILITY,
	advertiseMcpApps,
	assertMcpAppResourceLinks,
	clientSupportsMcpApps,
	createMcpAppResourceContent,
	createMcpAppResourceFragment,
	createMcpAppTextFallback,
	createMcpAppsFeature,
	createMcpAppToolFragment,
	getMcpAppsClientCapability,
	withMcpAppsServerCapability,
} from "../src/index.ts";

const RESOURCE_URI = "ui://weather/current";

describe("server capability helpers", () => {
	it("exports and merges the exact server advertisement", () => {
		expect(MCP_APPS_SERVER_CAPABILITY).toEqual({
			extensions: { "io.modelcontextprotocol/ui": {} },
		});
		expect(
			withMcpAppsServerCapability({
				tools: { listChanged: true },
				extensions: { "example/audit": { level: "public" } },
			}),
		).toEqual({
			tools: { listChanged: true },
			extensions: {
				"example/audit": { level: "public" },
				"io.modelcontextprotocol/ui": {},
			},
		});
	});

	it("advertises on a native split-v2 server", () => {
		const nativeServer = new McpServer({ name: "capability-test", version: "1.0.0" });
		advertiseMcpApps(nativeServer);
		expect(nativeServer.server.getCapabilities()).toEqual(MCP_APPS_SERVER_CAPABILITY);
	});

	it("recognizes only a valid client declaration containing the stable MIME", () => {
		const supported = {
			extensions: {
				[MCP_APPS_EXTENSION_ID]: {
					mimeTypes: ["text/plain", MCP_APP_RESOURCE_MIME_TYPE],
					futureSetting: true,
				},
			},
		};
		expect(clientSupportsMcpApps(supported)).toBe(true);
		expect(getMcpAppsClientCapability(supported)).toEqual({
			mimeTypes: ["text/plain", MCP_APP_RESOURCE_MIME_TYPE],
			futureSetting: true,
		});
		expect(clientSupportsMcpApps({ extensions: {} })).toBe(false);
		expect(clientSupportsMcpApps({ extensions: { [MCP_APPS_EXTENSION_ID]: {} } })).toBe(false);
		expect(
			clientSupportsMcpApps({
				extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html"] } },
			}),
		).toBe(false);
		expect(
			getMcpAppsClientCapability({
				extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [1] } },
			}),
		).toBeUndefined();
	});
});

describe("direct-server conformance", () => {
	let client: Client | undefined;
	let server: McpServer | undefined;
	let runtime: McpServerRuntime | undefined;

	afterEach(async () => {
		await client?.close();
		await server?.close();
		await runtime?.close();
	});

	it("serves stable Apps metadata, HTML, and text fallback through the official SDK", async () => {
		const register = vi.fn();
		runtime = new McpServerRuntime({
			name: "mcp-apps-conformance",
			serverInfo: { name: "mcp-apps-conformance", version: "1.0.0" },
			features: [
				createMcpAppsFeature((featureServer, context) => {
					register(context.runtimeName);
					assertMcpAppResourceLinks(
						[
							{
								name: "weather-current",
								...createMcpAppToolFragment({ resourceUri: RESOURCE_URI }),
							},
						],
						[{ uri: RESOURCE_URI }],
					);
					featureServer.registerTool(
						"weather-current",
						{
							description: "Return the current weather with an optional interactive view.",
							...createMcpAppToolFragment({ resourceUri: RESOURCE_URI }),
						},
						async () => ({
							...createMcpAppTextFallback("Current temperature: 21 °C, clear."),
							structuredContent: { temperatureC: 21, conditions: "clear" },
						}),
					);
					featureServer.registerResource(
						"weather-view",
						RESOURCE_URI,
						{
							description: "Interactive weather view.",
							...createMcpAppResourceFragment({
								csp: { connectDomains: ["https://api.example.com"] },
								prefersBorder: true,
							}),
						},
						async (uri) => ({
							contents: [
								createMcpAppResourceContent({
									uri: uri.href,
									text: "<!doctype html><title>Weather</title>",
									csp: { connectDomains: ["https://api.example.com"] },
									prefersBorder: true,
								}),
							],
						}),
					);
				}),
			],
		});
		server = await runtime.createServer({ era: "modern" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		client = new Client(
			{ name: "mcp-apps-client", version: "1.0.0" },
			{
				versionNegotiation: { mode: "auto" },
				capabilities: {
					extensions: {
						[MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] },
					},
				},
			},
		);
		await client.connect(clientTransport);

		expect(register).toHaveBeenCalledOnce();
		expect(client.getServerCapabilities()?.extensions?.[MCP_APPS_EXTENSION_ID]).toEqual({});

		const tools = await client.listTools();
		expect(tools.tools).toEqual([
			expect.objectContaining({
				name: "weather-current",
				_meta: {
					ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] },
					"ui/resourceUri": RESOURCE_URI,
				},
			}),
		]);

		const resources = await client.listResources();
		expect(resources.resources).toEqual([
			expect.objectContaining({
				name: "weather-view",
				uri: RESOURCE_URI,
				mimeType: MCP_APP_RESOURCE_MIME_TYPE,
				_meta: {
					ui: {
						csp: { connectDomains: ["https://api.example.com"] },
						prefersBorder: true,
					},
				},
			}),
		]);

		const resource = await client.readResource({ uri: RESOURCE_URI });
		expect(resource.contents).toEqual([
			{
				uri: RESOURCE_URI,
				mimeType: MCP_APP_RESOURCE_MIME_TYPE,
				text: "<!doctype html><title>Weather</title>",
				_meta: {
					ui: {
						csp: { connectDomains: ["https://api.example.com"] },
						prefersBorder: true,
					},
				},
			},
		]);

		const result = await client.callTool({ name: "weather-current" });
		expect(result.content).toEqual([{ type: "text", text: "Current temperature: 21 °C, clear." }]);
		expect(result.structuredContent).toEqual({ temperatureC: 21, conditions: "clear" });

		await client.close();
		await server.close();
		client = undefined;
		server = await runtime.createServer({ era: "modern" });
		const [plainClientTransport, plainServerTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(plainServerTransport);
		client = new Client(
			{ name: "plain-client", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(plainClientTransport);

		const plainResult = await client.callTool({ name: "weather-current" });
		expect(plainResult.content).toEqual([
			{ type: "text", text: "Current temperature: 21 °C, clear." },
		]);
		expect(register).toHaveBeenCalledTimes(2);
	});
});
