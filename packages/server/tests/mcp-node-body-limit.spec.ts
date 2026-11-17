import { connect } from "node:net";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { once } from "node:events";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { describe, expect, it, vi } from "vitest";
import { McpServerRuntime } from "../src/index.ts";

const expressNext: unknown = () => undefined;

describe("withMcpNodeBodyLimit over toNodeHandler", () => {
	it("rejects a chunked oversize body before the handler buffers it", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = new McpServerRuntime({
			name: "node-body-limit-test",
			serverInfo: { name: "node-body-limit-test", version: "1.0.0" },
			middleware: [async () => dispatched()],
			httpSecurity: { maxBodyBytes: 64 },
		});
		const server = createServer((request, response) => {
			void runtime.toNodeHandler()(toLike(request), response);
		});
		try {
			const baseUrl = await listen(server);
			// A streamed request body with no Content-Length arrives chunked.
			const oversize = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("x".repeat(48)));
						controller.enqueue(new TextEncoder().encode("y".repeat(48)));
						controller.close();
					},
				}),
				// @ts-expect-error Node fetch requires duplex for stream bodies.
				duplex: "half",
			});
			expect(oversize.status).toBe(413);
			expect(await oversize.text()).toContain("64-byte limit");
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			server.close();
			await runtime.close();
		}
	});

	it("rejects a declared oversize body from the Content-Length header alone", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = new McpServerRuntime({
			name: "node-body-limit-test",
			serverInfo: { name: "node-body-limit-test", version: "1.0.0" },
			middleware: [async () => dispatched()],
			httpSecurity: { maxBodyBytes: 64 },
		});
		const server = createServer((request, response) => {
			void runtime.toNodeHandler()(toLike(request), response);
		});
		try {
			const baseUrl = await listen(server);
			const oversize = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "z".repeat(256),
			});
			expect(oversize.status).toBe(413);
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			server.close();
			await runtime.close();
		}
	});

	it("replays an in-limit body to the handler intact", async () => {
		const runtime = new McpServerRuntime({
			name: "node-body-limit-test",
			serverInfo: { name: "node-body-limit-test", version: "1.0.0" },
			middleware: [
				async (operation) => new Response(await operation.input.request.text(), { status: 202 }),
			],
			httpSecurity: { maxBodyBytes: 1_024 },
		});
		const server = createServer((request, response) => {
			void runtime.toNodeHandler()(toLike(request), response);
		});
		try {
			const baseUrl = await listen(server);
			const response = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"hello":"node"}',
			});
			expect(response.status).toBe(202);
			expect(await response.text()).toBe('{"hello":"node"}');
		} finally {
			server.close();
			await runtime.close();
		}
	});

	it("does not crash the process when a peer aborts mid-upload", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		const adapterErrors: Error[] = [];
		const runtime = new McpServerRuntime({
			name: "node-body-limit-test",
			serverInfo: { name: "node-body-limit-test", version: "1.0.0" },
			middleware: [async () => new Response("ok")],
			httpSecurity: { maxBodyBytes: 1_048_576 },
		});
		const server = createServer((request, response) => {
			// Fire-and-forget mount: the returned promise is intentionally not awaited.
			void runtime
				.toNodeHandler({ onerror: (error) => adapterErrors.push(error) })(toLike(request), response)
				.catch(() => undefined);
		});
		try {
			const baseUrl = await listen(server);
			const { port } = new URL(baseUrl);
			await new Promise<void>((resolve) => {
				const socket = connect(Number(port), "127.0.0.1", () => {
					socket.write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nabc");
					// Abort before the declared body finishes.
					setTimeout(() => {
						socket.destroy();
						setTimeout(resolve, 50);
					}, 20);
				});
				socket.on("error", () => resolve());
			});
			// Give any rejection a tick to surface.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onRejection);
			server.close();
			await runtime.close();
		}
	});

	it("caps the body even when Express passes a next callback as the third argument", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = new McpServerRuntime({
			name: "node-body-limit-test",
			serverInfo: { name: "node-body-limit-test", version: "1.0.0" },
			middleware: [async () => dispatched()],
			httpSecurity: { maxBodyBytes: 64 },
		});
		const handler = runtime.toNodeHandler();
		const server = createServer((request, response) => {
			// Express/Connect invoke mounted handlers as (req, res, next).
			void handler(toLike(request), response, expressNext);
		});
		try {
			const baseUrl = await listen(server);
			const oversize = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "z".repeat(256),
			});
			expect(oversize.status).toBe(413);
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			server.close();
			await runtime.close();
		}
	});
});

function toLike(request: IncomingMessage): NodeIncomingMessageLike {
	const like = {
		headers: request.headers,
		...(request.method === undefined ? {} : { method: request.method }),
		...(request.url === undefined ? {} : { url: request.url }),
		resume: () => request.resume(),
		[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
	};
	return like;
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Expected an ephemeral TCP address.");
	}
	return `http://127.0.0.1:${String(address.port)}`;
}
