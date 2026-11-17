import {
	CallHandler,
	CanActivate,
	Controller,
	ExecutionContext,
	Inject,
	INestApplication,
	Injectable,
	NestInterceptor,
	UseInterceptors,
	VersioningType,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { Observable } from "rxjs";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { McpServerMiddleware, McpServerRuntime } from "@nest-mcp/server";
import { McpResourceServer } from "@nest-mcp/server/auth";
import { McpValidatedServer } from "@nest-mcp/server/security";
import { describe, expect, it, vi } from "vitest";
import { McpModule } from "../src/mcp.module.ts";
import { McpHttpControllerFor } from "../src/mcp-http.controller.ts";
import { McpRuntimeService } from "../src/mcp-runtime.service.ts";

type NestPlatform = "express" | "fastify";

const echoBodyMiddleware: McpServerMiddleware = async (operation) =>
	new Response(await operation.input.request.text(), { status: 202 });

@Injectable()
class ControllerTraceInterceptor implements NestInterceptor {
	readonly paths: string[] = [];

	intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
		const request = context.switchToHttp().getRequest<{ readonly url: string }>();
		this.paths.push(request.url);
		return next.handle();
	}
}

describe("McpHttpController", () => {
	it("rejects an empty named-server binding", () => {
		expect(() => McpHttpControllerFor("  ")).toThrowError(/non-empty string/);
	});

	it("lets a subclass short-circuit through Nest before MCP owns the response", async () => {
		const ControllerBase = McpHttpControllerFor("controller-server");
		@Controller("mcp")
		class InterceptingController extends ControllerBase {
			protected override interceptMcpRequest(): unknown {
				return { source: "nest" };
			}
		}
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					autoDiscover: false,
					servers: [
						{
							name: "controller-server",
							serverInfo: { name: "controller-server", version: "1.0.0" },
						},
					],
				}),
			],
			controllers: [InterceptingController],
		}).compile();
		const application = testingModule.createNestApplication();
		await application.listen(0, "127.0.0.1");
		try {
			const response = await fetch(`${await application.getUrl()}/mcp`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ source: "nest" });
		} finally {
			await application.close();
		}
	});

	it.each<NestPlatform>(["express", "fastify"])(
		"mounts through Nest %s with path, version, global guard, and fetch wrappers intact",
		async (platform) => {
			const middlewareToken = Symbol(`HTTP_MIDDLEWARE_${platform}`);
			const verifierToken = Symbol(`HTTP_TOKEN_VERIFIER_${platform}`);
			const guardPaths: string[] = [];
			const guard: CanActivate = {
				canActivate(context) {
					const request = context.switchToHttp().getRequest<{
						readonly headers: Readonly<Record<string, string | string[] | undefined>>;
						readonly url: string;
					}>();
					guardPaths.push(request.url);
					return request.headers["x-controller-access"] === "allowed";
				},
			};
			const verifyAccessToken = vi.fn(async (token: string): Promise<AuthInfo> => ({
				token,
				clientId: "nest-http-client",
				scopes: ["mcp:invoke"],
				expiresAt: Math.floor(Date.now() / 1_000) + 60,
			}));
			const verifier: OAuthTokenVerifier = { verifyAccessToken };
			const runtimeRequests: string[] = [];
			const middleware: McpServerMiddleware = async (operation) => {
				const request = operation.input.request;
				const body = await request.text();
				const path = new URL(request.url).pathname;
				const principal = operation.context.principal?.clientId ?? "anonymous";
				const summary = `${request.method}:${path}:${body}:${principal}`;
				runtimeRequests.push(summary);
				return new Response(summary, {
					status: 202,
					headers: { "content-type": "text/plain" },
				});
			};

			@Injectable()
			class HttpHandlerComposition {
				constructor(@Inject(verifierToken) private readonly tokenVerifier: OAuthTokenVerifier) {}

				create(runtime: McpServerRuntime): McpValidatedServer {
					return new McpValidatedServer(
						new McpResourceServer(runtime, {
							bearerAuth: { verifier: this.tokenVerifier, requiredScopes: ["mcp:invoke"] },
						}),
						{
							allowedHostnames: ["127.0.0.1"],
							allowedOriginHostnames: ["127.0.0.1"],
						},
					);
				}
			}

			const ControllerBase = McpHttpControllerFor("controller-server");

			@Controller({ path: "agents/mcp", version: "1" })
			@UseInterceptors(ControllerTraceInterceptor)
			class HostedMcpController extends ControllerBase {
				constructor(
					runtimeService: McpRuntimeService,
					private readonly composition: HttpHandlerComposition,
				) {
					super(runtimeService);
				}

				protected override createMcpHttpHandler(runtime: McpServerRuntime): McpValidatedServer {
					return this.composition.create(runtime);
				}
			}

			const testingModule = await Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						autoDiscover: false,
						collaborators: {
							providers: [{ provide: middlewareToken, useValue: { handle: middleware } }],
						},
						servers: [
							{
								name: "controller-server",
								serverInfo: { name: "controller-server", version: "1.0.0" },
								middleware: [middlewareToken],
							},
						],
					}),
				],
				controllers: [HostedMcpController],
				providers: [
					ControllerTraceInterceptor,
					HttpHandlerComposition,
					{ provide: APP_GUARD, useValue: guard },
					{ provide: verifierToken, useValue: verifier },
				],
			}).compile();
			const application = createApplication(testingModule, platform);
			application.setGlobalPrefix("api");
			application.enableVersioning({ type: VersioningType.URI });
			await application.listen(0, "127.0.0.1");

			try {
				const baseUrl = await application.getUrl();
				const route = `${baseUrl}/api/v1/agents/mcp`;
				const missingVersion = await fetch(`${baseUrl}/api/agents/mcp`, {
					headers: {
						authorization: "Bearer test-token",
						"x-controller-access": "allowed",
					},
				});
				expect(missingVersion.status).toBe(404);

				const blockedByGlobalGuard = await fetch(route);
				expect(blockedByGlobalGuard.status).toBe(403);
				expect(verifyAccessToken).not.toHaveBeenCalled();

				const blockedByOriginValidation = await fetch(route, {
					headers: {
						authorization: "Bearer test-token",
						origin: "https://evil.example",
						"x-controller-access": "allowed",
					},
				});
				expect(blockedByOriginValidation.status).toBe(403);
				expect(verifyAccessToken).not.toHaveBeenCalled();

				const blockedByBearerAuth = await fetch(route, {
					headers: { "x-controller-access": "allowed" },
				});
				expect(blockedByBearerAuth.status).toBe(401);
				expect(runtimeRequests).toEqual([]);

				const postResponse = await fetch(route, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token",
						"content-type": "application/json",
						"x-controller-access": "allowed",
					},
					body: JSON.stringify({ hello: "world" }),
				});
				expect(postResponse.status).toBe(202);
				expect(await postResponse.text()).toBe(
					'POST:/api/v1/agents/mcp:{"hello":"world"}:nest-http-client',
				);

				const deleteResponse = await fetch(route, {
					method: "DELETE",
					headers: {
						authorization: "Bearer test-token",
						"x-controller-access": "allowed",
					},
				});
				expect(deleteResponse.status).toBe(202);
				expect(await deleteResponse.text()).toBe("DELETE:/api/v1/agents/mcp::nest-http-client");

				expect(verifyAccessToken).toHaveBeenCalledTimes(2);
				expect(verifyAccessToken).toHaveBeenNthCalledWith(1, "test-token");
				expect(runtimeRequests).toEqual([
					'POST:/api/v1/agents/mcp:{"hello":"world"}:nest-http-client',
					"DELETE:/api/v1/agents/mcp::nest-http-client",
				]);
				expect(guardPaths).toContain("/api/v1/agents/mcp");
				expect(application.get(ControllerTraceInterceptor).paths).toEqual([
					"/api/v1/agents/mcp",
					"/api/v1/agents/mcp",
					"/api/v1/agents/mcp",
					"/api/v1/agents/mcp",
				]);
			} finally {
				await application.close();
			}
		},
	);
	it.each<NestPlatform>(["express", "fastify"])(
		"applies the default HTTP security posture and honors controller overrides on %s",
		async (platform) => {
			const middlewareToken = Symbol(`HTTP_SECURITY_MIDDLEWARE_${platform}`);

			const DefaultBase = McpHttpControllerFor("posture-server");
			@Controller("default/mcp")
			class DefaultPostureController extends DefaultBase {}

			const CappedBase = McpHttpControllerFor("capped-server");
			@Controller("capped/mcp")
			class CappedController extends CappedBase {}

			const OverrideBase = McpHttpControllerFor("posture-server");
			@Controller("override/mcp")
			class OverrideController extends OverrideBase {
				protected override getHttpSecurityOptions() {
					return { allowedOriginHostnames: ["partner.example"] };
				}
			}

			const testingModule = await Test.createTestingModule({
				imports: [
					McpModule.forRoot({
						autoDiscover: false,
						collaborators: {
							providers: [{ provide: middlewareToken, useValue: { handle: echoBodyMiddleware } }],
						},
						servers: [
							{
								name: "posture-server",
								serverInfo: { name: "posture-server", version: "1.0.0" },
								middleware: [middlewareToken],
							},
							{
								name: "capped-server",
								serverInfo: { name: "capped-server", version: "1.0.0" },
								middleware: [middlewareToken],
								httpSecurity: { maxBodyBytes: 64 },
							},
						],
					}),
				],
				controllers: [DefaultPostureController, CappedController, OverrideController],
			}).compile();
			const application = createApplication(testingModule, platform);
			await application.listen(0, "127.0.0.1");

			try {
				const baseUrl = await application.getUrl();

				// Default posture: routable browser origins are denied with no config.
				const deniedOrigin = await fetch(`${baseUrl}/default/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "https://evil.example" },
					body: "{}",
				});
				expect(deniedOrigin.status).toBe(403);
				expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();

				// Default posture: localhost-class preflights succeed and never dispatch.
				const preflight = await fetch(`${baseUrl}/default/mcp`, {
					method: "OPTIONS",
					headers: {
						origin: "http://localhost:5173",
						"access-control-request-method": "POST",
						"access-control-request-headers": "mcp-method, content-type",
					},
				});
				expect(preflight.status).toBe(200);
				expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
				expect(preflight.headers.get("access-control-allow-headers")).toBe(
					"mcp-method, content-type",
				);

				// Allowed origins get CORS decoration on actual responses.
				const decorated = await fetch(`${baseUrl}/default/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "http://localhost:5173" },
					body: '{"hello":"cors"}',
				});
				expect(decorated.status).toBe(202);
				expect(decorated.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
				expect(await decorated.text()).toBe('{"hello":"cors"}');

				// Platform-parsed oversize bodies are capped at the fetch layer.
				const oversize = await fetch(`${baseUrl}/capped/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ payload: "x".repeat(1_024) }),
				});
				expect(oversize.status).toBe(413);

				// The controller override replaces the runtime posture entirely.
				const allowedByOverride = await fetch(`${baseUrl}/override/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "https://partner.example" },
					body: '{"hello":"override"}',
				});
				expect(allowedByOverride.status).toBe(202);
				expect(allowedByOverride.headers.get("access-control-allow-origin")).toBe(
					"https://partner.example",
				);
				const deniedByOverride = await fetch(`${baseUrl}/override/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "http://localhost:5173" },
					body: "{}",
				});
				expect(deniedByOverride.status).toBe(403);
			} finally {
				await application.close();
			}
		},
	);
});

function createApplication(testingModule: TestingModule, platform: NestPlatform): INestApplication {
	return platform === "fastify"
		? testingModule.createNestApplication(new FastifyAdapter())
		: testingModule.createNestApplication(new ExpressAdapter());
}
