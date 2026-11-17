import { Test } from "@nestjs/testing";
import { McpDocumentFetchError } from "@nest-mcp/auth/cimd";
import { beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { McpEndpointAdmissionService } from "../src/runtime/mcp-endpoint-admission.service.ts";
import { createGuardedTransportFetch } from "../src/runtime/runtime-generation.module.ts";
import {
	MCP_CONTROL_PLANE_GUARDED_FETCH,
	type McpGuardedTransportFetch,
} from "../src/runtime/runtime.types.ts";

interface GuardedRequest {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

describe("McpEndpointAdmissionService", () => {
	let service: McpEndpointAdmissionService;
	let requests: GuardedRequest[];

	beforeEach(async () => {
		requests = [];
		const guardedFetch: McpGuardedTransportFetch = async (url, init) => {
			requests.push({ url: String(url), init });
			return new Response(null, { status: 204 });
		};
		service = await createService(guardedFetch);
	});

	it("admits exact HTTPS hosts and loopback HTTP while canonicalizing the endpoint", () => {
		expect(service.admit("https://mcp.example.test/service")).toEqual({
			url: "https://mcp.example.test/service",
			host: "mcp.example.test",
		});
		expect(service.admit("http://127.0.0.1:4321/mcp")).toEqual({
			url: "http://127.0.0.1:4321/mcp",
			host: "127.0.0.1:4321",
		});
		// The shared guarded-host normalization treats a trailing root dot as the
		// same name, so the allowlist matches where the old exact Set did not.
		expect(service.admit("https://MCP.Example.Test./service").host).toBe("mcp.example.test.");
	});

	it.each([
		"https://not-allowed.example.test/mcp",
		"http://mcp.example.test/mcp",
		"https://user:secret@mcp.example.test/mcp",
		"https://mcp.example.test/mcp?token=secret",
		"https://mcp.example.test/mcp#fragment",
	])("rejects an endpoint outside the admitted, secret-free boundary: %s", (endpoint) => {
		expect(() => service.admit(endpoint)).toThrowError(
			expect.objectContaining({ code: "MCP_ENDPOINT_REJECTED" }),
		);
	});

	it("pins transport requests to the admitted origin and delegates them to the guarded fetch", async () => {
		const guarded = service.createFetch("https://mcp.example.test/mcp");

		await expect(guarded("https://not-allowed.example.test/mcp")).rejects.toMatchObject({
			code: "MCP_ENDPOINT_REJECTED",
		});
		expect(requests).toHaveLength(0);

		const response = await guarded("https://mcp.example.test/mcp", { method: "POST" });
		expect(response.status).toBe(204);
		expect(requests).toEqual([{ url: "https://mcp.example.test/mcp", init: { method: "POST" } }]);
	});

	it.each([
		["blocked-address", "MCP_ENDPOINT_REJECTED"],
		["host-not-allowed", "MCP_ENDPOINT_REJECTED"],
		["insecure-url", "MCP_ENDPOINT_REJECTED"],
		["too-large", "MCP_DOCUMENT_FETCH_FAILED"],
		["timeout", "MCP_DOCUMENT_FETCH_FAILED"],
		["network", "MCP_DOCUMENT_FETCH_FAILED"],
	] as const)("reports a guarded %s failure as %s", async (reason, code) => {
		const failing = await createService(() => {
			throw new McpDocumentFetchError(reason, "guarded transport refused the request");
		});

		await expect(
			failing.createFetch("https://mcp.example.test/mcp")("https://mcp.example.test/mcp"),
		).rejects.toMatchObject({ code });
	});
});

async function createService(
	guardedFetch: McpGuardedTransportFetch,
): Promise<McpEndpointAdmissionService> {
	const module = await Test.createTestingModule({
		providers: [
			McpEndpointAdmissionService,
			{
				provide: ControlPlaneConfigService,
				useValue: {
					allowedHosts: ["127.0.0.1", "localhost", "mcp.example.test"],
					allowLoopbackHttp: true,
				},
			},
			{ provide: MCP_CONTROL_PLANE_GUARDED_FETCH, useValue: guardedFetch },
		],
	}).compile();
	return module.get(McpEndpointAdmissionService);
}

describe("guarded transport fetch", () => {
	it.each([
		["https://not-allowed.example.test/mcp", true, "host-not-allowed"],
		["http://mcp.example.test/mcp", false, "insecure-url"],
		["https://10.0.0.5/mcp", true, "blocked-address"],
	])(
		"refuses %s before any connection is attempted",
		async (endpoint, allowLoopbackHttp, reason) => {
			const module = await Test.createTestingModule({
				providers: [
					{
						provide: ControlPlaneConfigService,
						useValue: {
							allowedHosts: ["127.0.0.1", "localhost", "mcp.example.test", "10.0.0.5"],
							allowLoopbackHttp,
						},
					},
					{
						provide: MCP_CONTROL_PLANE_GUARDED_FETCH,
						inject: [ControlPlaneConfigService],
						useFactory: createGuardedTransportFetch,
					},
				],
			}).compile();
			const guarded = module.get<McpGuardedTransportFetch>(MCP_CONTROL_PLANE_GUARDED_FETCH);

			await expect(guarded(endpoint)).rejects.toMatchObject({
				name: "McpDocumentFetchError",
				reason,
			});
		},
	);
});
