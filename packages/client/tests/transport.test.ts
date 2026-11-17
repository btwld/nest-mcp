import type { Middleware } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
	AuthorizationServerMismatchError,
	Client,
	ClientCredentialsProvider,
	CrossAppAccessProvider,
	InsecureTokenEndpointError,
	InsufficientScopeError,
	IssuerMismatchError,
	OAuthClientFlowError,
	PrivateKeyJwtProvider,
	RegistrationRejectedError,
	StaticPrivateKeyJwtProvider,
	StdioClientTransport,
	StreamableHTTPClientTransport,
	UnauthorizedError,
	composeMcpFetchMiddleware,
	createMcpClientTransport,
	createMcpHttpClientTransport,
	createMcpStdioClientTransport,
} from "../src/index.ts";

describe("MCP client transport factories", () => {
	it("uses the official middleware composition pipeline", async () => {
		const calls: string[] = [];
		const first: Middleware = (next) => async (url, init) => {
			calls.push("first:before");
			const response = await next(url, init);
			calls.push("first:after");
			return response;
		};
		const second: Middleware = (next) => async (url, init) => {
			calls.push("second:before");
			const response = await next(url, init);
			calls.push("second:after");
			return response;
		};
		const fetch = composeMcpFetchMiddleware([first, second], async () => {
			calls.push("fetch");
			return new Response(null, { status: 204 });
		});

		await fetch("https://mcp.example.test");

		expect(calls).toEqual([
			"second:before",
			"first:before",
			"fetch",
			"first:after",
			"second:after",
		]);
	});

	it("creates the official HTTP and stdio transports", () => {
		expect(
			createMcpClientTransport({ kind: "http", url: "https://mcp.example.test" }),
		).toBeInstanceOf(StreamableHTTPClientTransport);
		expect(
			createMcpClientTransport({ kind: "stdio", command: "node", args: ["server.mjs"] }),
		).toBeInstanceOf(StdioClientTransport);
	});

	it("rejects unsupported HTTP URLs and empty stdio commands", () => {
		expect(() =>
			createMcpHttpClientTransport({ kind: "http", url: "file:///tmp/mcp.sock" }),
		).toThrow("must use http: or https:");
		expect(() => createMcpStdioClientTransport({ kind: "stdio", command: "  " })).toThrow(
			"must be a non-empty string",
		);
	});

	it("re-exports the curated official client and OAuth surface", () => {
		for (const exported of [
			Client,
			ClientCredentialsProvider,
			PrivateKeyJwtProvider,
			StaticPrivateKeyJwtProvider,
			CrossAppAccessProvider,
			UnauthorizedError,
			AuthorizationServerMismatchError,
			InsecureTokenEndpointError,
			InsufficientScopeError,
			IssuerMismatchError,
			OAuthClientFlowError,
			RegistrationRejectedError,
		]) {
			expect(exported).toBeTypeOf("function");
		}
	});
});
