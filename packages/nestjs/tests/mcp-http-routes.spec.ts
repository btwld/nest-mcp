import "reflect-metadata";
import {
	Inject,
	Injectable,
	Module,
	RequestMethod,
	SetMetadata,
	UseGuards,
	UseInterceptors,
	VersioningType,
	type CanActivate,
	type ExecutionContext,
	type NestInterceptor,
	type CallHandler,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { McpModule, Targets, Tool, type McpHttpRoute } from "../src/index.ts";

const PUBLIC_DISCOVERY = "test:public-discovery";
const ISSUER = "https://issuer.test/api/auth";
const RESOURCE = "https://registry.test/api/v1/mcp";
const RESOURCE_PATH = ".well-known/oauth-protected-resource/api/v1/mcp";
const RESOURCE_ALIAS = ".well-known/oauth-protected-resource";
const AUTH_PATH = ".well-known/oauth-authorization-server/api/auth";
const VERIFIER = Symbol("verifier");
const CONFIG = Symbol("config");

@Injectable()
class RouteGuard implements CanActivate {
	constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
	canActivate(context: ExecutionContext) {
		if (this.reflector.get<boolean>(PUBLIC_DISCOVERY, context.getClass())) return true;
		return (
			context.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
				"x-route-access"
			] === "yes"
		);
	}
}

@Injectable()
class TraceInterceptor implements NestInterceptor {
	count = 0;
	intercept(_context: ExecutionContext, next: CallHandler) {
		this.count++;
		return next.handle();
	}
}

@Injectable()
@Targets("artifact")
class ExampleTools {
	@Tool({ name: "example" })
	example() {
		return { content: [{ type: "text" as const, text: "generated route" }] };
	}
}

@Module({ providers: [{ provide: CONFIG, useValue: RESOURCE }], exports: [CONFIG] })
class ConfigurationModule {}

describe("declarative MCP HTTP routes", () => {
	it.each(["express", "fastify"] as const)(
		"serves tools and public discovery through %s with async options, prefix, version and decorators",
		async (platform) => {
			const verifyAccessToken = vi.fn(async (token: string): Promise<AuthInfo> => {
				if (token !== "valid") throw new Error("invalid token");
				return {
					token,
					clientId: "routes-test",
					scopes: ["mcp:invoke"],
					expiresAt: Math.floor(Date.now() / 1000) + 60,
				};
			});
			const module = await Test.createTestingModule({
				imports: [
					McpModule.forRootAsync({
						imports: [ConfigurationModule],
						inject: [CONFIG],
						httpRoutes: [
							{
								serverName: "artifact",
								path: "/mcp",
								version: "1",
								decorators: [UseGuards(RouteGuard), UseInterceptors(TraceInterceptor)],
								discovery: {
									protectedResourcePaths: [RESOURCE_PATH, RESOURCE_ALIAS],
									authorizationServerPaths: [AUTH_PATH],
									decorators: [UseGuards(RouteGuard), SetMetadata(PUBLIC_DISCOVERY, true)],
								},
							},
						],
						collaborators: {
							providers: [
								RouteGuard,
								TraceInterceptor,
								{ provide: VERIFIER, useValue: { verifyAccessToken } },
							],
						},
						useFactory: (resourceUrl: string) => ({
							servers: [
								{
									name: "artifact",
									serverInfo: { name: "artifact", version: "1" },
									httpSecurity: { maxBodyBytes: 8192 },
									oauth: {
										resource: {
											resourceServerUrl: resourceUrl,
											verifier: VERIFIER,
											requiredScopes: ["mcp:invoke"],
											metadata: {
												scopesSupported: ["mcp:invoke"],
												resourceName: "Artifacts",
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
					}),
				],
				providers: [ExampleTools],
			}).compile();
			const adapter = platform === "express" ? new ExpressAdapter() : new FastifyAdapter();
			const app = module.createNestApplication(adapter, { logger: false });
			app.setGlobalPrefix("api", {
				exclude: [RESOURCE_PATH, RESOURCE_ALIAS, AUTH_PATH].map((path) => ({
					path,
					method: RequestMethod.ALL,
				})),
			});
			app.enableVersioning({ type: VersioningType.URI, defaultVersion: "2" });
			await app.listen(0, "127.0.0.1");
			const origin = await app.getUrl();
			const url = `${origin}/api/v1/mcp`;
			const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
			const client = new Client({ name: "route-test", version: "1" });
			try {
				const denied = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				expect(denied.status).toBe(403);
				expect(verifyAccessToken).not.toHaveBeenCalled();
				const unauthorized = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json", "x-route-access": "yes" },
					body,
				});
				expect(unauthorized.status).toBe(401);
				expect(unauthorized.headers.get("www-authenticate")).toContain(RESOURCE_PATH);

				for (const path of [RESOURCE_PATH, RESOURCE_ALIAS]) {
					const response = await fetch(`${origin}/${path}`);
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({
						resource: RESOURCE,
						authorization_servers: [ISSUER],
						scopes_supported: ["mcp:invoke"],
						resource_name: "Artifacts",
					});
					expect(response.headers.get("access-control-allow-origin")).toBe("*");
				}
				const auth = await fetch(`${origin}/${AUTH_PATH}`);
				expect((await auth.json()).issuer).toBe(ISSUER);
				const head = await fetch(`${origin}/${RESOURCE_PATH}`, { method: "HEAD" });
				expect(head.status).toBe(200);
				expect(await head.text()).toBe("");
				const preflight = await fetch(`${origin}/${RESOURCE_PATH}`, { method: "OPTIONS" });
				expect(preflight.status).toBe(204);
				const post = await fetch(`${origin}/${RESOURCE_PATH}`, { method: "POST" });
				expect(post.status).toBe(405);
				expect(post.headers.get("allow")).toContain("GET");

				await client.connect(
					new StreamableHTTPClientTransport(new URL(url), {
						requestInit: { headers: { authorization: "Bearer valid", "x-route-access": "yes" } },
					}),
				);
				expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("example");
				expect(await client.callTool({ name: "example", arguments: {} })).toMatchObject({
					content: [{ type: "text", text: "generated route" }],
				});
				expect(app.get(TraceInterceptor).count).toBeGreaterThan(0);
				const badOrigin = await fetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-route-access": "yes",
						authorization: "Bearer valid",
						origin: "https://untrusted.test",
					},
					body,
				});
				expect(badOrigin.status).toBe(403);
				const large = await fetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-route-access": "yes",
						authorization: "Bearer valid",
					},
					body: JSON.stringify({ content: "x".repeat(10000) }),
				});
				expect(large.status).toBe(413);
			} finally {
				await client.close();
				await app.close();
			}
		},
	);

	it("registers sync routes for separate runtimes without mixing their names", async () => {
		const module = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					autoDiscover: false,
					httpRoutes: [
						{ serverName: "one", path: "one" },
						{ serverName: "two", path: "two" },
					],
					servers: ["one", "two"].map((name) => ({ name, serverInfo: { name, version: "1" } })),
				}),
			],
		}).compile();
		const app = module.createNestApplication(new FastifyAdapter(), { logger: false });
		await app.listen(0, "127.0.0.1");
		try {
			for (const name of ["one", "two"]) {
				const client = new Client({ name: "multi-route", version: "1" });
				try {
					await client.connect(
						new StreamableHTTPClientTransport(new URL(`${await app.getUrl()}/${name}`)),
					);
					expect(client.getServerVersion()?.name).toBe(name);
				} finally {
					await client.close();
				}
			}
		} finally {
			await app.close();
		}
	});

	it("keeps HTTP registration opt-in", () => {
		expect(McpModule.forRoot().controllers ?? []).toEqual([]);
	});

	it.each([
		"",
		"https://host.test/mcp",
		"mcp?token=x",
		"mcp#fragment",
		"mcp/:id",
		"mcp/*",
		"mcp/../other",
		"mcp//other",
	])("rejects non-literal route %s", (path) => {
		expect(() => McpModule.forRoot({ httpRoutes: [{ serverName: "artifact", path }] })).toThrow(
			/HTTP route/,
		);
	});

	it("rejects colliding transport and discovery routes before Nest registers either", () => {
		expect(() =>
			McpModule.forRoot({
				httpRoutes: [
					{ serverName: "artifact", path: "/mcp/", discovery: { protectedResourcePaths: ["MCP"] } },
				],
			}),
		).toThrow(/Duplicate/);
	});

	it.each([
		{ route: { serverName: "missing", path: "mcp" }, message: /unknown MCP server/ },
		{
			route: {
				serverName: "artifact",
				path: "mcp",
				discovery: { protectedResourcePaths: [".well-known/oauth-protected-resource/mcp"] },
			},
			message: /requires oauth.resource.metadata/,
		},
	])("rejects unresolved async runtime/discovery definitions", async ({ route, message }) => {
		await expect(
			Test.createTestingModule({
				imports: [
					McpModule.forRootAsync({
						httpRoutes: [route],
						useFactory: () => ({
							servers: [{ name: "artifact", serverInfo: { name: "artifact", version: "1" } }],
						}),
					}),
				],
			}).compile(),
		).rejects.toThrow(message);
	});

	it("rejects discovery that omits the advertised bearer challenge path", async () => {
		await expect(
			Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						httpRoutes: [
							{
								serverName: "artifact",
								path: "mcp",
								discovery: { protectedResourcePaths: [RESOURCE_ALIAS] },
							},
						],
						collaborators: {
							providers: [{ provide: VERIFIER, useValue: { verifyAccessToken: vi.fn() } }],
						},
						servers: [
							{
								name: "artifact",
								serverInfo: { name: "artifact", version: "1" },
								oauth: {
									resource: {
										resourceServerUrl: RESOURCE,
										verifier: VERIFIER,
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
			}).compile(),
		).rejects.toThrow(/must include its bearer challenge path/);
	});

	it("rejects empty discovery and invalid decorators", () => {
		expect(() =>
			McpModule.forRoot({ httpRoutes: [{ serverName: "artifact", path: "mcp", discovery: {} }] }),
		).toThrow(/at least one/);
		const route: McpHttpRoute = {
			serverName: "artifact",
			path: "mcp",
			// @ts-expect-error JavaScript callers can supply invalid decorators.
			decorators: ["invalid"],
		};
		expect(() => McpModule.forRoot({ httpRoutes: [route] })).toThrow(/class decorator/);
	});
});
