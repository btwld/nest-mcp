import type { InputRequiredResult, ServerCapabilities, Tool } from "@modelcontextprotocol/server";
import { McpClientRuntime } from "@nest-mcp/client";
import { describe, expect, it, vi } from "vitest";
import {
	McpGateway,
	allowAllMcpGatewayPolicy,
	createMcpClientRuntimeUpstream,
} from "../src/index.ts";

function runtimeWithCapabilities(capabilities: ServerCapabilities): McpClientRuntime {
	const runtime = new McpClientRuntime();
	vi.spyOn(runtime, "snapshot").mockReturnValue({
		name: "upstream",
		state: "connected",
		transportKind: "http",
		serverCapabilities: capabilities,
	});
	vi.spyOn(runtime, "request").mockImplementation(async (_serverName, request) => {
		if (request.method === "tools/list") return { tools: [] };
		if (request.method === "prompts/list") return { prompts: [] };
		if (request.method === "resources/list") return { resources: [] };
		if (request.method === "resources/templates/list") return { resourceTemplates: [] };
		throw new Error("Unexpected request.");
	});
	vi.spyOn(runtime, "complete").mockResolvedValue({ completion: { values: ["value"] } });
	return runtime;
}

describe("createMcpClientRuntimeUpstream", () => {
	it("omits unsupported strict capabilities", async () => {
		const upstream = createMcpClientRuntimeUpstream(
			runtimeWithCapabilities({ tools: {} }),
			"upstream",
		);
		if (typeof upstream.client !== "function") throw new Error("Expected resolver.");
		const client = await upstream.client({
			authorizationContext: "principal-a",
			signal: new AbortController().signal,
		});

		expect("listPrompts" in client).toBe(false);
		expect("getPrompt" in client).toBe(false);
		expect("listResources" in client).toBe(false);
		expect("readResource" in client).toBe(false);
		await expect(client.listTools({ cursor: "page-2" })).resolves.toEqual({ tools: [] });
	});

	it("includes supported prompt, resource-template, and completion methods", async () => {
		const upstream = createMcpClientRuntimeUpstream(
			runtimeWithCapabilities({ tools: {}, prompts: {}, resources: {}, completions: {} }),
			"upstream",
		);
		if (typeof upstream.client !== "function") throw new Error("Expected resolver.");
		const client = await upstream.client({
			authorizationContext: "principal-a",
			signal: new AbortController().signal,
		});

		expect(typeof client.listPrompts).toBe("function");
		expect(typeof client.getPrompt).toBe("function");
		expect(typeof client.listResources).toBe("function");
		expect(typeof client.readResource).toBe("function");
		expect(typeof client.listResourceTemplates).toBe("function");
		expect(typeof client.complete).toBe("function");
		await expect(client.listResourceTemplates?.({ cursor: "page-2" })).resolves.toEqual({
			resourceTemplates: [],
		});
		await expect(
			client.complete?.({
				ref: { type: "ref/prompt", name: "prompt" },
				argument: { name: "language", value: "t" },
			}),
		).resolves.toEqual({ completion: { values: ["value"] } });
	});

	it("uses manual MRTR mode and fails closed instead of auto-fulfilling upstream input", async () => {
		const runtime = runtimeWithCapabilities({ tools: {} });
		const continuation = {
			resultType: "input_required",
			requestState: "opaque-upstream-state",
			inputRequests: {},
		} satisfies InputRequiredResult;
		const manual = vi.spyOn(runtime, "requestWithInputRequired");
		const callTool = vi.spyOn(runtime, "callTool").mockResolvedValue(continuation);
		const upstream = createMcpClientRuntimeUpstream(runtime, "upstream", "projected");
		if (typeof upstream.client !== "function") throw new Error("Expected resolver.");
		const client = await upstream.client({
			authorizationContext: "principal-a",
			signal: new AbortController().signal,
		});
		const tool = {
			name: "approve",
			inputSchema: { type: "object" },
			outputSchema: {
				type: "object",
				properties: { approved: { type: "boolean" } },
			},
		} satisfies Tool;

		await expect(
			client.callTool(
				{ name: tool.name, arguments: { artifactId: "artifact-1" } },
				{ toolDefinition: tool },
			),
		).rejects.toMatchObject({ code: "UPSTREAM_INPUT_REQUIRED" });
		expect(manual).not.toHaveBeenCalled();
		expect(callTool).toHaveBeenCalledWith(
			"upstream",
			{ name: "approve", arguments: { artifactId: "artifact-1" } },
			expect.objectContaining({
				allowInputRequired: true,
				toolDefinition: expect.not.objectContaining({ outputSchema: expect.anything() }),
			}),
		);
	});

	it("preserves SEP-2243 definitions and validates complete structured output locally", async () => {
		const runtime = runtimeWithCapabilities({ tools: {} });
		const manual = vi.spyOn(runtime, "requestWithInputRequired");
		const callTool = vi.spyOn(runtime, "callTool").mockResolvedValue({
			content: [],
			structuredContent: { value: "valid" },
		});
		const upstream = createMcpClientRuntimeUpstream(runtime, "upstream", "projected");
		if (typeof upstream.client !== "function") throw new Error("Expected resolver.");
		const client = await upstream.client({
			authorizationContext: "principal-a",
			signal: new AbortController().signal,
		});
		const tool = {
			name: "header-bound",
			inputSchema: {
				type: "object",
				properties: {
					tenant: { type: "string", "x-mcp-header": "X-Tenant" },
				},
			},
			outputSchema: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
		} satisfies Tool;

		await expect(
			client.callTool({ name: tool.name, arguments: { tenant: "acme" } }, { toolDefinition: tool }),
		).resolves.toMatchObject({ structuredContent: { value: "valid" } });
		expect(manual).not.toHaveBeenCalled();
		expect(callTool).toHaveBeenCalledWith(
			"upstream",
			{ name: tool.name, arguments: { tenant: "acme" } },
			expect.objectContaining({
				allowInputRequired: true,
				toolDefinition: expect.objectContaining({ inputSchema: tool.inputSchema }),
			}),
		);
		const forwardedDefinition = callTool.mock.calls[0]?.[2]?.toolDefinition;
		expect(forwardedDefinition).not.toHaveProperty("outputSchema");

		callTool.mockResolvedValueOnce({ content: [], structuredContent: { value: 42 } });
		await expect(
			client.callTool({ name: tool.name, arguments: { tenant: "acme" } }, { toolDefinition: tool }),
		).rejects.toMatchObject({ code: "INVALID_INVOCATION_RESULT" });
	});

	it("treats an explicitly resource-only runtime as an empty tools namespace", async () => {
		const runtime = runtimeWithCapabilities({ resources: {} });
		const request = vi
			.spyOn(runtime, "request")
			.mockImplementation(async (_serverName, operation) => {
				if (operation.method === "resources/list") {
					return { resources: [{ name: "note", uri: "test://resource-only/note" }] };
				}
				if (operation.method === "resources/templates/list") return { resourceTemplates: [] };
				throw new Error(`Unexpected request: ${operation.method}`);
			});
		const upstream = createMcpClientRuntimeUpstream(runtime, "upstream", "projected");
		if (typeof upstream.client !== "function") throw new Error("Expected resolver.");
		const client = await upstream.client({
			authorizationContext: "principal-a",
			signal: new AbortController().signal,
		});

		await expect(client.listTools()).resolves.toEqual({ tools: [] });
		expect(request).not.toHaveBeenCalled();
		await expect(client.callTool({ name: "missing" })).rejects.toMatchObject({
			code: "UNSUPPORTED_UPSTREAM_CAPABILITY",
		});

		const gateway = new McpGateway({
			upstreams: [upstream],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		await expect(gateway.listProjectedTools()).resolves.toEqual([]);
		await expect(gateway.listProjectedResources()).resolves.toHaveLength(1);
		expect(request.mock.calls.some(([, operation]) => operation.method === "tools/list")).toBe(
			false,
		);
	});
});
