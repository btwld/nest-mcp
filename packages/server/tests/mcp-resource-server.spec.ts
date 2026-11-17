import type { AuthInfo } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { McpResourceServer } from "../src/auth/index.ts";
import { McpServerRuntime } from "../src/index.ts";

describe("McpResourceServer", () => {
	it("rejects missing tokens before dispatch", async () => {
		const handler = createHandler();
		const fetch = vi.spyOn(handler, "fetch");
		const resourceServer = new McpResourceServer(handler, {
			bearerAuth: {
				verifier: { verifyAccessToken: vi.fn<() => Promise<AuthInfo>>() },
				requiredScopes: ["mcp"],
			},
		});

		try {
			const response = await resourceServer.fetch(new Request("https://api.example.com/mcp"));

			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain("invalid_token");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await resourceServer.close();
		}
	});

	it("passes verified identity into the MCP handler", async () => {
		const authInfo: AuthInfo = {
			token: "secret",
			clientId: "artifact-agent",
			scopes: ["mcp"],
			expiresAt: Date.now() / 1000 + 60,
		};
		const handler = createHandler();
		const fetch = vi.spyOn(handler, "fetch");
		const resourceServer = new McpResourceServer(handler, {
			bearerAuth: {
				verifier: { verifyAccessToken: async () => authInfo },
				requiredScopes: ["mcp"],
			},
		});

		try {
			await resourceServer.fetch(
				new Request("https://api.example.com/mcp", {
					headers: { authorization: "Bearer secret" },
				}),
			);

			expect(fetch).toHaveBeenCalledWith(
				expect.any(Request),
				expect.objectContaining({ authInfo }),
			);
		} finally {
			await resourceServer.close();
		}
	});
});

function createHandler(): McpServerRuntime {
	return new McpServerRuntime({
		name: "auth-test",
		serverInfo: { name: "auth-test", version: "1.0.0" },
		middleware: [async () => new Response("ok")],
	});
}
