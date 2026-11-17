import { METHOD_NOT_FOUND, ProtocolError } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
	createMcpClientInspectionTarget,
	discoverMcpClientCatalog,
	McpClientCatalogLimitError,
	McpClientRuntime,
} from "../src/index.ts";

const tool = { name: "search", inputSchema: { type: "object" as const } };
function fixture(allCapabilities = false) {
	const runtime = new McpClientRuntime({
		servers: [{ name: "test", transport: { kind: "http", url: "https://mcp.example/mcp" } }],
	});
	vi.spyOn(runtime, "snapshot").mockReturnValue({
		...runtime.snapshot("test"),
		serverCapabilities: { tools: {}, ...(allCapabilities ? { resources: {}, prompts: {} } : {}) },
	});
	const request = vi.spyOn(runtime, "request");
	const input = {
		runtime,
		serverName: "test",
		signal: new AbortController().signal,
		maxPages: 2,
		maxItems: 10,
	};
	return { input, request };
}

describe("bounded passive catalog inspection", () => {
	it("walks raw pages, returns detached immutable data, and rejects repeating cursors", async () => {
		const { input, request } = fixture();
		request
			.mockResolvedValueOnce({ tools: [tool], nextCursor: "next" })
			.mockResolvedValueOnce({ tools: [{ ...tool, name: "read" }] });
		const catalog = await discoverMcpClientCatalog(input);
		expect(catalog.tools.map(({ name }) => name)).toEqual(["search", "read"]);
		expect(Object.isFrozen(catalog.tools[0]?.inputSchema)).toBe(true);
		expect(catalog.tools[0]).not.toBe(tool);
		expect(request).toHaveBeenLastCalledWith(
			"test",
			{ method: "tools/list", params: { cursor: "next" } },
			{ signal: input.signal },
		);
		request.mockResolvedValue({ tools: [], nextCursor: "repeat" });
		await expect(discoverMcpClientCatalog(input)).rejects.toThrow(/cursor repeated/u);
	});
	it("rejects partial catalogs at the page and total item budgets", async () => {
		const { input, request } = fixture();
		request.mockResolvedValue({ tools: [tool], nextCursor: "next" });
		await expect(discoverMcpClientCatalog({ ...input, maxPages: 1 })).rejects.toBeInstanceOf(
			McpClientCatalogLimitError,
		);
		request.mockResolvedValue({ tools: [tool, tool] });
		await expect(discoverMcpClientCatalog({ ...input, maxItems: 1 })).rejects.toBeInstanceOf(
			McpClientCatalogLimitError,
		);
	});
	it("tolerates only method-not-found for the optional resource-template list", async () => {
		const { input, request } = fixture(true);
		request
			.mockResolvedValueOnce({ tools: [] })
			.mockResolvedValueOnce({ resources: [] })
			.mockRejectedValueOnce(new ProtocolError(METHOD_NOT_FOUND, "unsupported"))
			.mockResolvedValueOnce({ prompts: [] });
		await expect(discoverMcpClientCatalog(input)).resolves.toMatchObject({ resourceTemplates: [] });
		request
			.mockResolvedValueOnce({ tools: [] })
			.mockResolvedValueOnce({ resources: [] })
			.mockRejectedValueOnce(new Error("transport"));
		await expect(discoverMcpClientCatalog(input)).rejects.toThrow("transport");
	});
	it("settles a complete parallel wave before propagating a failure", async () => {
		const { input, request } = fixture(true);
		let resolve!: (value: { prompts: [] }) => void;
		const pending = new Promise<{ prompts: [] }>((settle) => {
			resolve = settle;
		});
		request
			.mockRejectedValueOnce(new Error("tools failure"))
			.mockResolvedValueOnce({ resources: [] })
			.mockResolvedValueOnce({ resourceTemplates: [] })
			.mockReturnValueOnce(pending);
		let settled = false;
		const result = discoverMcpClientCatalog({ ...input, mode: "parallel" }).finally(() => {
			settled = true;
		});
		void result.catch(() => {});
		await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
		expect(settled).toBe(false);
		resolve({ prompts: [] });
		await expect(result).rejects.toThrow("tools failure");
	});
	it("shares one catalog per diagnostic run and respects lease cancellation", async () => {
		const { input, request } = fixture();
		const controller = new AbortController();
		request.mockResolvedValue({ tools: [tool] });
		const target = createMcpClientInspectionTarget({ ...input, leaseSignal: controller.signal });
		expect(await target.catalog(input.signal)).toBe(await target.catalog(input.signal));
		expect(request).toHaveBeenCalledOnce();
		expect(target.schemaCompiles(tool.inputSchema)).toBe(true);
		expect(target.schemaCompiles({ type: "invalid" })).toBe(false);
		controller.abort(new Error("revoked"));
		expect(() => target.catalog(input.signal)).toThrow("revoked");
	});
	it("observes provider changes after an ordinary SDK list has been cached", async () => {
		let name = "before";
		const handler = createMcpHandler(
			() => {
				const server = new McpServer({ name: "inspection", version: "1" });
				server.registerTool(name, { inputSchema: {} }, () => ({ content: [] }));
				return server;
			},
			{ legacy: "reject" },
		);
		const runtime = new McpClientRuntime({
			servers: [
				{
					name: "test",
					transport: {
						kind: "http",
						url: "https://mcp.example/mcp",
						fetch: (input, init) => handler.fetch(new Request(input, init)),
					},
				},
			],
		});
		try {
			await runtime.connect("test");
			expect((await runtime.listTools("test")).tools[0]?.name).toBe("before");
			name = "after";
			const catalog = await discoverMcpClientCatalog({
				runtime,
				serverName: "test",
				signal: new AbortController().signal,
				maxPages: 2,
				maxItems: 10,
			});
			expect(catalog.tools[0]?.name).toBe("after");
		} finally {
			await runtime.close();
			await handler.close();
		}
	});
});
