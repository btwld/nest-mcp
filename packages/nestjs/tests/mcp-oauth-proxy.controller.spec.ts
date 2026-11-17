import { createHash, randomBytes } from "node:crypto";
import { Controller, INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { McpMemoryOAuthStore, createMcpTokenKeyRing, generateMcpSigningKey } from "@nest-mcp/auth";
import type {
	McpFetchLike,
	McpOAuthClient,
	McpOAuthClientResolver,
	McpTokenKeyRing,
	McpUpstreamAuthorizationServer,
} from "@nest-mcp/auth";
import { describe, expect, it } from "vitest";
import { McpModule } from "../src/mcp.module.ts";
import { McpHttpControllerFor } from "../src/mcp-http.controller.ts";
import { McpOAuthControllerFor } from "../src/oauth/mcp-oauth.controller.ts";
import type {
	McpOAuthFetchProvider,
	McpOAuthSecretProvider,
	McpOAuthSigningKeyProvider,
	McpOAuthUpstreamProvider,
} from "../src/index.ts";

type NestPlatform = "express" | "fastify";

const RESOURCE = "https://mcp.example.com/mcp";
const UPSTREAM_ISSUER = "https://idp.example.com";
const CLIENT_ID = "https://app.example.com/oauth/client.json";
const REDIRECT_URI = "https://app.example.com/callback";

function makeIdToken(subject: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ iss: UPSTREAM_ISSUER, aud: "proxy-client", sub: subject, exp: 9_999_999_999 }),
	).toString("base64url");
	return `${header}.${payload}.`;
}

function fakeUpstreamFetch(): McpFetchLike {
	return async (input) => {
		const url = new URL(input);
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			return new Response(
				JSON.stringify({
					issuer: UPSTREAM_ISSUER,
					authorization_endpoint: `${UPSTREAM_ISSUER}/authorize`,
					token_endpoint: `${UPSTREAM_ISSUER}/token`,
					response_types_supported: ["code"],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url.pathname === "/token") {
			return new Response(
				JSON.stringify({
					access_token: "upstream-access",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "upstream-refresh",
					id_token: makeIdToken("user-1"),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	};
}

const CLIENT: McpOAuthClient = {
	clientId: CLIENT_ID,
	clientName: "Example App",
	redirectUris: [REDIRECT_URI],
	tokenEndpointAuthMethod: "none",
	loopbackOnly: false,
	source: "registered",
};

function createModule(platform: NestPlatform): Promise<TestingModule> {
	const ring: McpTokenKeyRing = createMcpTokenKeyRing({ keys: [generateMcpSigningKey("EdDSA")] });
	const signingKeys: McpOAuthSigningKeyProvider = { getSigningKeys: () => ring };
	const secret: McpOAuthSecretProvider = { getMasterSecret: () => randomBytes(32) };
	const upstreamConfig: McpUpstreamAuthorizationServer = {
		issuer: UPSTREAM_ISSUER,
		clientId: "proxy-client",
		clientSecret: "proxy-secret",
		scopes: ["openid"],
	};
	const upstream: McpOAuthUpstreamProvider = { getUpstream: () => upstreamConfig };
	const fetchProvider: McpOAuthFetchProvider = { fetch: fakeUpstreamFetch() };
	const clientResolver: McpOAuthClientResolver = {
		resolveClient: async (id) => (id === CLIENT_ID ? CLIENT : undefined),
	};
	const store = new McpMemoryOAuthStore({ now: () => Date.now() });

	const signingToken = Symbol(`SIGNING_${platform}`);
	const secretToken = Symbol(`SECRET_${platform}`);
	const upstreamToken = Symbol(`UPSTREAM_${platform}`);
	const fetchToken = Symbol(`FETCH_${platform}`);
	const clientToken = Symbol(`CLIENT_${platform}`);
	const storeToken = Symbol(`STORE_${platform}`);

	const McpBase = McpHttpControllerFor("proxy-server");
	@Controller("mcp")
	class ProxyMcpController extends McpBase {}
	const OAuthBase = McpOAuthControllerFor("proxy-server");
	@Controller()
	class ProxyOAuthController extends OAuthBase {}

	return Test.createTestingModule({
		imports: [
			McpModule.forRoot({
				autoDiscover: false,
				collaborators: {
					providers: [
						{ provide: signingToken, useValue: signingKeys },
						{ provide: secretToken, useValue: secret },
						{ provide: upstreamToken, useValue: upstream },
						{ provide: fetchToken, useValue: fetchProvider },
						{ provide: clientToken, useValue: clientResolver },
						{ provide: storeToken, useValue: store },
					],
				},
				servers: [
					{
						name: "proxy-server",
						serverInfo: { name: "proxy-server", version: "1.0.0" },
						httpSecurity: { allowedOriginHostnames: ["127.0.0.1"] },
						oauth: {
							proxy: {
								issuer: "http://127.0.0.1",
								resources: [RESOURCE],
								scopesSupported: ["mcp:invoke"],
								signingKeys: signingToken,
								secret: secretToken,
								upstream: upstreamToken,
								fetch: fetchToken,
								stateStore: storeToken,
								clientResolver: clientToken,
								requiredScopes: ["mcp:invoke"],
							},
						},
					},
				],
			}),
		],
		controllers: [ProxyMcpController, ProxyOAuthController],
	}).compile();
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
async function readJson<T>(response: Response): Promise<T> {
	const body: T = await response.json();
	return body;
}

function createApplication(testingModule: TestingModule, platform: NestPlatform): INestApplication {
	return platform === "fastify"
		? testingModule.createNestApplication(new FastifyAdapter())
		: testingModule.createNestApplication(new ExpressAdapter());
}

describe("McpOAuthControllerFor", () => {
	it.each<NestPlatform>(["express", "fastify"])(
		"serves discovery, JWKS, and a form-encoded token endpoint on %s",
		async (platform) => {
			const application = createApplication(await createModule(platform), platform);
			await application.listen(0, "127.0.0.1");
			try {
				const baseUrl = await application.getUrl();

				const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
				expect(metadata.status).toBe(200);
				const metadataBody = await readJson<{
					code_challenge_methods_supported: string[];
					client_id_metadata_document_supported: boolean;
					token_endpoint: string;
				}>(metadata);
				expect(metadataBody.code_challenge_methods_supported).toEqual(["S256"]);
				expect(metadataBody.token_endpoint).toContain("/oauth/token");

				const jwks = await fetch(`${baseUrl}/.well-known/jwks.json`);
				expect(jwks.status).toBe(200);
				expect((await readJson<{ keys: unknown[] }>(jwks)).keys.length).toBeGreaterThan(0);

				// /authorize sets the session cookie and renders consent.
				const verifier = randomBytes(32).toString("base64url");
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
				authorizeUrl.searchParams.set("client_id", CLIENT_ID);
				authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
				authorizeUrl.searchParams.set("response_type", "code");
				authorizeUrl.searchParams.set("code_challenge", challenge);
				authorizeUrl.searchParams.set("code_challenge_method", "S256");
				authorizeUrl.searchParams.set("resource", RESOURCE);
				authorizeUrl.searchParams.set("scope", "mcp:invoke");
				const authorize = await fetch(authorizeUrl.href, { redirect: "manual" });
				expect(authorize.status).toBe(200);
				expect(authorize.headers.get("content-type")).toContain("text/html");
				const setCookie = authorize.headers.get("set-cookie") ?? "";
				expect(setCookie).toContain("__Host-nest_mcp_authz");
				expect(setCookie).toContain("HttpOnly");

				// A form-encoded token request with an invalid code is a clean 400 (not a parse error).
				const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: "nonexistent",
						redirect_uri: REDIRECT_URI,
						code_verifier: verifier,
						client_id: CLIENT_ID,
					}).toString(),
				});
				expect(tokenResponse.status).toBe(400);
				expect((await readJson<{ error: string }>(tokenResponse)).error).toBe("invalid_grant");

				// A non-OAuth path under the controller is a 404.
				const unknown = await fetch(`${baseUrl}/oauth/unknown`);
				expect(unknown.status).toBe(404);
			} finally {
				await application.close();
			}
		},
	);
});
