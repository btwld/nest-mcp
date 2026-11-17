import { describe, expect, it, vi } from "vitest";
import { McpServerRuntime } from "../src/index.ts";
import { McpValidatedServer } from "../src/security/index.ts";

describe("McpValidatedServer", () => {
	it("rejects untrusted hosts before dispatch", async () => {
		const handler = createHandler();
		const fetch = vi.spyOn(handler, "fetch");
		const server = new McpValidatedServer(handler, {
			allowedHostnames: ["api.example.com"],
			allowedOriginHostnames: ["app.example.com"],
		});

		try {
			const response = await server.fetch(
				new Request("https://evil.example/mcp", { headers: { host: "evil.example" } }),
			);

			expect(response.status).toBe(403);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await server.close();
		}
	});

	it("allows configured host and origin", async () => {
		const handler = createHandler();
		const fetch = vi.spyOn(handler, "fetch");
		const server = new McpValidatedServer(handler, {
			allowedHostnames: ["api.example.com"],
			allowedOriginHostnames: ["app.example.com"],
		});

		try {
			const response = await server.fetch(
				new Request("https://api.example.com/mcp", {
					headers: { host: "api.example.com", origin: "https://app.example.com" },
				}),
			);

			expect(response.status).toBe(200);
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			await server.close();
		}
	});
});

function createHandler(): McpServerRuntime {
	return new McpServerRuntime({
		name: "validation-test",
		serverInfo: { name: "validation-test", version: "1.0.0" },
		middleware: [async () => new Response("ok")],
	});
}
