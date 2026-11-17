import { Controller, INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpProxyTokenVerifier } from "@nest-mcp/auth";
import { createMcpTestKeyRing } from "@nest-mcp/auth/testing";
import { describe, expect, it } from "vitest";
import { McpModule } from "../src/mcp.module.ts";
import { McpHttpControllerFor } from "../src/mcp-http.controller.ts";
import type { McpAnonymousAccessPolicy, McpOAuthTokenVerifierProvider } from "../src/index.ts";

type NestPlatform = "express" | "fastify";

const ISSUER = "https://issuer.test";
const RESOURCE = "https://mcp.example.com/mcp";

describe("McpModule oauth.resource wiring", () => {
	it.each<NestPlatform>(["express", "fastify"])(
		"protects the MCP route with bearer verification on %s",
		async (platform) => {
			const verifierToken = Symbol(`OAUTH_VERIFIER_${platform}`);
			const { ring, mintAccessToken } = createMcpTestKeyRing({ issuer: ISSUER });
			const verifier: McpOAuthTokenVerifierProvider = createMcpProxyTokenVerifier({
				ring,
				issuer: ISSUER,
				resources: [RESOURCE],
			});

			const ControllerBase = McpHttpControllerFor("oauth-server");
			@Controller("mcp")
			class OAuthController extends ControllerBase {}

			const testingModule = await Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						autoDiscover: false,
						collaborators: { providers: [{ provide: verifierToken, useValue: verifier }] },
						servers: [
							{
								name: "oauth-server",
								serverInfo: { name: "oauth-server", version: "1.0.0" },
								// Local requests come from 127.0.0.1; allow that origin for CORS.
								httpSecurity: { allowedOriginHostnames: ["127.0.0.1"] },
								oauth: {
									resource: {
										resourceServerUrl: RESOURCE,
										requiredScopes: ["mcp:invoke"],
										verifier: verifierToken,
										metadata: {
											oauthMetadata: {
												issuer: ISSUER,
												authorization_endpoint: `${ISSUER}/authorize`,
												token_endpoint: `${ISSUER}/token`,
												response_types_supported: ["code"],
											},
										},
									},
								},
							},
						],
					}),
				],
				controllers: [OAuthController],
			}).compile();
			const application = createApplication(testingModule, platform);
			await application.listen(0, "127.0.0.1");

			try {
				const baseUrl = await application.getUrl();

				const unauthorized = await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
				});
				expect(unauthorized.status).toBe(401);
				const challenge = unauthorized.headers.get("www-authenticate") ?? "";
				expect(challenge).toContain("Bearer");
				// Configured metadata surfaces the RFC 9728 resource-metadata URL in
				// the challenge so a client can begin its OAuth flow. (Serving the
				// well-known document at origin root is the dedicated OAuth
				// controller's responsibility, added in a later phase.)
				expect(challenge).toContain("resource_metadata=");

				// A valid bearer token passes verification and reaches the handler.
				const token = mintAccessToken({ aud: RESOURCE });
				const authorized = await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						authorization: `Bearer ${token}`,
						"mcp-protocol-version": "2026-07-28",
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
				});
				// A valid token clears the resource-server gate and reaches the SDK
				// (whose own envelope handling is out of scope here); it is never a
				// 401/403 from the auth layer.
				expect(authorized.status).not.toBe(401);
				expect(authorized.status).not.toBe(403);

				const forgedScope = mintAccessToken({ aud: RESOURCE, scope: "other:scope" });
				const insufficient = await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${forgedScope}`,
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
				});
				expect(insufficient.status).toBe(403);
			} finally {
				await application.close();
			}
		},
	);

	it("admits requests through a fail-closed anonymous policy", async () => {
		const verifierToken = Symbol("OAUTH_VERIFIER_ANON");
		const anonymousToken = Symbol("OAUTH_ANONYMOUS");
		const { ring } = createMcpTestKeyRing({ issuer: ISSUER });
		const verifier: McpOAuthTokenVerifierProvider = createMcpProxyTokenVerifier({
			ring,
			issuer: ISSUER,
			resources: [RESOURCE],
		});
		const anonymous: McpAnonymousAccessPolicy = {
			permit: (request): AuthInfo | undefined =>
				request.headers.get("x-allow-anon") === "yes"
					? { token: "anon", clientId: "anonymous", scopes: [], expiresAt: 4_102_444_800 }
					: undefined,
		};

		const ControllerBase = McpHttpControllerFor("anon-server");
		@Controller("mcp")
		class AnonController extends ControllerBase {}

		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					autoDiscover: false,
					collaborators: {
						providers: [
							{ provide: verifierToken, useValue: verifier },
							{ provide: anonymousToken, useValue: anonymous },
						],
					},
					servers: [
						{
							name: "anon-server",
							serverInfo: { name: "anon-server", version: "1.0.0" },
							httpSecurity: { allowedOriginHostnames: ["127.0.0.1"] },
							oauth: {
								resource: {
									resourceServerUrl: RESOURCE,
									verifier: verifierToken,
									anonymous: anonymousToken,
								},
							},
						},
					],
				}),
			],
			controllers: [AnonController],
		}).compile();
		const application = createApplication(testingModule, "express");
		await application.listen(0, "127.0.0.1");

		try {
			const baseUrl = await application.getUrl();
			const denied = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(denied.status).toBe(401);

			const allowed = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"x-allow-anon": "yes",
					"mcp-protocol-version": "2026-07-28",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			// The anonymous policy admitted the request past the bearer gate.
			expect(allowed.status).not.toBe(401);
			expect(allowed.status).not.toBe(403);
		} finally {
			await application.close();
		}
	});

	it("rejects an oauth.resource group missing its verifier provider", async () => {
		const ControllerBase = McpHttpControllerFor("bad-oauth-server");
		@Controller("mcp")
		class BadController extends ControllerBase {}

		await expect(
			Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						autoDiscover: false,
						servers: [
							{
								name: "bad-oauth-server",
								serverInfo: { name: "bad-oauth-server", version: "1.0.0" },
								oauth: {
									resource: {
										resourceServerUrl: RESOURCE,
										verifier: Symbol("MISSING_VERIFIER"),
									},
								},
							},
						],
					}),
				],
				controllers: [BadController],
			})
				.compile()
				.then((moduleRef) => moduleRef.init()),
		).rejects.toThrowError(/collaborator/);
	});
});

function createApplication(testingModule: TestingModule, platform: NestPlatform): INestApplication {
	return platform === "fastify"
		? testingModule.createNestApplication(new FastifyAdapter())
		: testingModule.createNestApplication(new ExpressAdapter());
}
