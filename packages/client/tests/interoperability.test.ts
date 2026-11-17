import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";

import {
	SdkErrorCode,
	SdkHttpError,
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
	localhostHostValidation,
	localhostOriginValidation,
	NodeStreamableHTTPServerTransport,
	toNodeHandler,
	type NodeIncomingMessageLike,
	type NodeServerResponseLike,
} from "@modelcontextprotocol/node";
import {
	completable,
	createMcpHandler,
	InMemoryServerEventBus,
	McpServer,
	ResourceTemplate,
	type McpHttpHandler,
	type McpRequestContext,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
	auth,
	ClientCredentialsProvider,
	McpClientRuntime,
	UnauthorizedError,
	type AuthProvider,
} from "../src/index.ts";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const OAUTH_SCOPE = "mcp:tools";
const MACHINE_CLIENT_ID = "machine-client";
const MACHINE_CLIENT_SECRET = "machine-secret";
const INTERACTIVE_CLIENT_ID = "interactive-client";
const INTERACTIVE_REDIRECT_URI = "http://127.0.0.1/oauth/callback";
const AUTHORIZATION_CODE = "approved-code";

describe("MCP client interoperability", () => {
	const runtimes: McpClientRuntime[] = [];
	const handlers: McpHttpHandler[] = [];
	const servers: StartedHttpServer[] = [];

	afterEach(async () => {
		const failures: unknown[] = [];
		for (const runtime of runtimes.splice(0).toReversed()) {
			try {
				await runtime.close();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const handler of handlers.splice(0).toReversed()) {
			try {
				await handler.close();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const server of servers.splice(0).toReversed()) {
			try {
				await server.close();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Interoperability fixture cleanup failed.");
		}
	});

	function trackRuntime(runtime: McpClientRuntime): McpClientRuntime {
		runtimes.push(runtime);
		return runtime;
	}

	function trackHandler(handler: McpHttpHandler): McpHttpHandler {
		handlers.push(handler);
		return handler;
	}

	async function trackServer(server: Promise<StartedHttpServer>): Promise<StartedHttpServer> {
		const started = await server;
		servers.push(started);
		return started;
	}

	it("auto-negotiates modern and legacy Streamable HTTP servers over loopback", async () => {
		const modernContexts: McpRequestContext[] = [];
		const modernHandler = trackHandler(
			createEchoHandler("modern-http", modernContexts, { legacy: "reject" }),
		);
		const modernServer = await trackServer(startMcpHttpServer(modernHandler));
		const legacyServer = await startLegacyMcpHttpServer();
		servers.push(legacyServer);
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "modern",
						transport: { kind: "http", url: modernServer.url },
					},
					{
						name: "legacy",
						transport: { kind: "http", url: legacyServer.url },
					},
				],
			}),
		);

		const connected = await runtime.connectAll();
		const modernResult = await runtime.callTool("modern", {
			name: "echo",
			arguments: { text: "modern round trip" },
		});
		const legacyResult = await runtime.callTool("legacy", {
			name: "echo",
			arguments: { text: "legacy round trip" },
		});
		await expect(runtime.ping("legacy")).resolves.toEqual({});

		expect([...connected.keys()]).toEqual(["modern", "legacy"]);
		expect((await runtime.listTools("modern")).tools.map(({ name }) => name)).toEqual(["echo"]);
		expect((await runtime.listTools("legacy")).tools.map(({ name }) => name)).toEqual(["echo"]);
		expect(modernResult.content).toEqual([{ type: "text", text: "modern round trip" }]);
		expect(legacyResult.content).toEqual([{ type: "text", text: "legacy round trip" }]);
		expect(runtime.snapshot("modern")).toMatchObject({
			state: "connected",
			transportKind: "http",
			protocolEra: "modern",
			negotiatedProtocolVersion: MODERN_PROTOCOL_VERSION,
		});
		expect(runtime.snapshot("legacy")).toMatchObject({
			state: "connected",
			transportKind: "http",
			protocolEra: "legacy",
			negotiatedProtocolVersion: LEGACY_PROTOCOL_VERSION,
		});
		expect(legacyServer.sessionId).toBeTruthy();
		expect(modernContexts.length).toBeGreaterThan(0);
		expect(modernContexts.every(({ era }) => era === "modern")).toBe(true);
	});

	it("retries a 401 once after a bearer provider rotates its token", async () => {
		const handler = trackHandler(createEchoHandler("bearer-http"));
		const observedAuthorization: Array<string | null> = [];
		const protectedServer = await trackServer(
			startBearerMcpHttpServer(handler, "current-token", observedAuthorization),
		);
		let token = "expired-token";
		const onUnauthorized = vi.fn(async () => {
			token = "current-token";
		});
		const authProvider: AuthProvider = {
			token: async () => token,
			onUnauthorized,
		};
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "bearer",
						transport: {
							kind: "http",
							url: protectedServer.url,
							authProvider,
						},
					},
				],
			}),
		);

		await runtime.connect("bearer");
		const result = await runtime.callTool("bearer", {
			name: "echo",
			arguments: { text: "authenticated" },
		});

		expect(result.content).toEqual([{ type: "text", text: "authenticated" }]);
		expect(onUnauthorized).toHaveBeenCalledOnce();
		expect(observedAuthorization[0]).toBe("Bearer expired-token");
		expect(observedAuthorization.slice(1).every((value) => value === "Bearer current-token")).toBe(
			true,
		);
		expect(JSON.stringify(runtime.snapshot("bearer"))).not.toContain("expired-token");
		expect(JSON.stringify(runtime.snapshot("bearer"))).not.toContain("current-token");
	});

	it("completes OAuth client-credentials discovery and token exchange", async () => {
		const handler = trackHandler(createEchoHandler("oauth-client-credentials"));
		const oauthServer = await createOAuthMcpServer(handler);
		servers.push(oauthServer);
		const provider = new ClientCredentialsProvider({
			clientId: MACHINE_CLIENT_ID,
			clientSecret: MACHINE_CLIENT_SECRET,
			expectedIssuer: oauthServer.issuer,
			scope: OAUTH_SCOPE,
		});
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "oauth-machine",
						transport: {
							kind: "http",
							url: oauthServer.url,
							authProvider: provider,
						},
					},
				],
			}),
		);

		await runtime.connect("oauth-machine");
		const result = await runtime.callTool("oauth-machine", {
			name: "echo",
			arguments: { text: "machine authorized" },
		});
		const request = oauthServer.tokenRequests[0];
		const tokens = provider.tokens();

		expect(result.content).toEqual([{ type: "text", text: "machine authorized" }]);
		expect(oauthServer.resourceMetadataRequests).toBe(1);
		expect(oauthServer.authorizationMetadataRequests).toBe(1);
		expect(oauthServer.tokenRequests).toHaveLength(1);
		expect(request?.authorization).toBe(
			"Basic " + Buffer.from(MACHINE_CLIENT_ID + ":" + MACHINE_CLIENT_SECRET).toString("base64"),
		);
		expect(request?.parameters.get("grant_type")).toBe("client_credentials");
		expect(request?.parameters.get("scope")).toBe(OAUTH_SCOPE);
		expect(request?.parameters.get("resource")).toBe(oauthServer.url.href);
		expect(request?.parameters.has("client_secret")).toBe(false);
		expect(tokens).toMatchObject({
			access_token: "token-client_credentials",
			token_type: "Bearer",
			scope: OAUTH_SCOPE,
			issuer: oauthServer.issuer,
		});
		expect(oauthServer.mcpAuthorizationHeaders[0]).toBeNull();
		expect(
			oauthServer.mcpAuthorizationHeaders
				.slice(1)
				.every((value) => value === "Bearer token-client_credentials"),
		).toBe(true);
		expect(oauthServer.url.origin).not.toBe(oauthServer.issuer);
		expect(runtime.snapshot("oauth-machine")).toMatchObject({
			state: "connected",
			protocolEra: "modern",
			negotiatedProtocolVersion: MODERN_PROTOCOL_VERSION,
		});
	});

	it("supports an interactive OAuth redirect, PKCE callback, and reconnect", async () => {
		const handler = trackHandler(createEchoHandler("oauth-authorization-code"));
		const oauthServer = await createOAuthMcpServer(handler);
		servers.push(oauthServer);
		const provider = new InteractiveOAuthProvider(oauthServer.issuer);
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "oauth-interactive",
						transport: {
							kind: "http",
							url: oauthServer.url,
							authProvider: provider,
						},
					},
				],
			}),
		);

		const connectFailure = await captureFailure(runtime.connect("oauth-interactive"));
		const authorizationUrl = provider.authorizationUrl;

		expect(UnauthorizedError.isInstance(connectFailure)).toBe(true);
		expect(authorizationUrl).toBeInstanceOf(URL);
		if (authorizationUrl === undefined) throw new Error("OAuth redirect was not captured.");
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
			oauthServer.issuer + "/authorize",
		);
		expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizationUrl.searchParams.get("client_id")).toBe(INTERACTIVE_CLIENT_ID);
		expect(authorizationUrl.searchParams.get("scope")).toBe(OAUTH_SCOPE);
		expect(provider.authorizationState).not.toBe("");
		expect(authorizationUrl.searchParams.get("state")).toBe(provider.authorizationState);
		expect(authorizationUrl.searchParams.get("resource")).toBe(oauthServer.url.href);
		expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
		const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
		const callbackLocation = authorizationResponse.headers.get("location");
		if (callbackLocation === null) throw new Error("OAuth callback redirect was not returned.");
		const callbackUrl = new URL(callbackLocation);
		const callbackState = callbackUrl.searchParams.get("state");
		if (callbackState !== provider.authorizationState) {
			throw new Error("OAuth callback state did not match.");
		}
		const callbackCode = callbackUrl.searchParams.get("code");
		if (callbackCode === null) throw new Error("OAuth callback did not contain a code.");
		const callbackIssuer = callbackUrl.searchParams.get("iss");
		if (callbackIssuer === null) throw new Error("OAuth callback did not contain an issuer.");

		await expect(
			auth(provider, {
				serverUrl: oauthServer.url,
				authorizationCode: callbackCode,
				iss: callbackIssuer,
			}),
		).resolves.toBe("AUTHORIZED");
		await runtime.connect("oauth-interactive");
		const result = await runtime.callTool("oauth-interactive", {
			name: "echo",
			arguments: { text: "user authorized" },
		});
		const request = oauthServer.tokenRequests[0];

		expect(result.content).toEqual([{ type: "text", text: "user authorized" }]);
		expect(authorizationResponse.status).toBe(302);
		expect(callbackCode).toBe(AUTHORIZATION_CODE);
		expect(callbackIssuer).toBe(oauthServer.issuer);
		expect(oauthServer.tokenRequests).toHaveLength(1);
		expect(request?.authorization).toBeNull();
		expect(request?.parameters.get("grant_type")).toBe("authorization_code");
		expect(request?.parameters.get("code")).toBe(AUTHORIZATION_CODE);
		expect(request?.parameters.get("client_id")).toBe(INTERACTIVE_CLIENT_ID);
		expect(request?.parameters.get("redirect_uri")).toBe(provider.redirectUrl.href);
		expect(request?.parameters.get("code_verifier")).toBe(provider.savedCodeVerifier);
		expect(provider.savedCodeVerifier.length).toBeGreaterThan(40);
		expect(provider.tokens()).toMatchObject({
			access_token: "token-authorization_code",
			token_type: "Bearer",
			issuer: oauthServer.issuer,
		});
		expect(runtime.snapshot("oauth-interactive")).toMatchObject({
			state: "connected",
			protocolEra: "modern",
			negotiatedProtocolVersion: MODERN_PROTOCOL_VERSION,
		});
	});

	it("uses each rotated interactive OAuth refresh token on the next resource-server 401", async () => {
		const handler = trackHandler(createEchoHandler("oauth-refresh"));
		const oauthServer = await createOAuthMcpServer(handler);
		servers.push(oauthServer);
		const provider = new InteractiveOAuthProvider(oauthServer.issuer);
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "oauth-refresh",
						transport: {
							kind: "http",
							url: oauthServer.url,
							authProvider: provider,
						},
					},
				],
			}),
		);

		await completeInteractiveAuthorization(runtime, "oauth-refresh", oauthServer, provider);
		await runtime.connect("oauth-refresh");
		expect(provider.tokens()).toMatchObject({
			access_token: "token-authorization_code",
			refresh_token: "refresh-authorization_code",
		});

		oauthServer.revokeAccessToken("token-authorization_code");
		const authorizationOffset = oauthServer.mcpAuthorizationHeaders.length;
		const firstResult = await runtime.callTool("oauth-refresh", {
			name: "echo",
			arguments: { text: "first refreshed authorization" },
		});
		const firstRefreshRequest = oauthServer.tokenRequests[1];

		expect(firstResult.content).toEqual([{ type: "text", text: "first refreshed authorization" }]);
		expect(oauthServer.tokenRequests).toHaveLength(2);
		expect(firstRefreshRequest?.authorization).toBeNull();
		expect(firstRefreshRequest?.parameters.get("grant_type")).toBe("refresh_token");
		expect(firstRefreshRequest?.parameters.get("refresh_token")).toBe("refresh-authorization_code");
		expect(firstRefreshRequest?.parameters.get("client_id")).toBe(INTERACTIVE_CLIENT_ID);
		expect(firstRefreshRequest?.parameters.get("resource")).toBe(oauthServer.url.href);
		expect(firstRefreshRequest?.parameters.has("scope")).toBe(false);
		expect(oauthServer.mcpAuthorizationHeaders.slice(authorizationOffset)).toEqual([
			"Bearer token-authorization_code",
			"Bearer token-refresh-1",
		]);
		expect(provider.tokens()).toMatchObject({
			access_token: "token-refresh-1",
			refresh_token: "refresh-rotated-1",
			token_type: "Bearer",
			issuer: oauthServer.issuer,
		});

		oauthServer.revokeAccessToken("token-refresh-1");
		const secondAuthorizationOffset = oauthServer.mcpAuthorizationHeaders.length;
		const secondResult = await runtime.callTool("oauth-refresh", {
			name: "echo",
			arguments: { text: "second refreshed authorization" },
		});
		const secondRefreshRequest = oauthServer.tokenRequests[2];

		expect(secondResult.content).toEqual([
			{ type: "text", text: "second refreshed authorization" },
		]);
		expect(oauthServer.tokenRequests).toHaveLength(3);
		expect(secondRefreshRequest?.authorization).toBeNull();
		expect(secondRefreshRequest?.parameters.get("grant_type")).toBe("refresh_token");
		expect(secondRefreshRequest?.parameters.get("refresh_token")).toBe("refresh-rotated-1");
		expect(secondRefreshRequest?.parameters.get("client_id")).toBe(INTERACTIVE_CLIENT_ID);
		expect(secondRefreshRequest?.parameters.get("resource")).toBe(oauthServer.url.href);
		expect(secondRefreshRequest?.parameters.has("scope")).toBe(false);
		expect(oauthServer.mcpAuthorizationHeaders.slice(secondAuthorizationOffset)).toEqual([
			"Bearer token-refresh-1",
			"Bearer token-refresh-2",
		]);
		expect(provider.tokens()).toMatchObject({
			access_token: "token-refresh-2",
			refresh_token: "refresh-rotated-2",
			token_type: "Bearer",
			issuer: oauthServer.issuer,
		});
	});

	it("bounds OAuth refresh to one retry when the replacement access token is also rejected", async () => {
		const handler = trackHandler(createEchoHandler("oauth-refresh-rejected"));
		const oauthServer = await createOAuthMcpServer(handler);
		servers.push(oauthServer);
		const provider = new InteractiveOAuthProvider(oauthServer.issuer);
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "oauth-refresh-rejected",
						transport: {
							kind: "http",
							url: oauthServer.url,
							authProvider: provider,
						},
					},
				],
			}),
		);

		await completeInteractiveAuthorization(
			runtime,
			"oauth-refresh-rejected",
			oauthServer,
			provider,
		);
		await runtime.connect("oauth-refresh-rejected");
		oauthServer.revokeAccessToken("token-authorization_code");
		oauthServer.rejectAccessToken("token-refresh-1");
		const authorizationOffset = oauthServer.mcpAuthorizationHeaders.length;
		const failure = await captureFailure(
			runtime.callTool("oauth-refresh-rejected", {
				name: "echo",
				arguments: { text: "must remain unauthorized" },
			}),
		);
		const refreshRequest = oauthServer.tokenRequests[1];

		expect(SdkHttpError.isInstance(failure)).toBe(true);
		expect(failure).toMatchObject({
			code: SdkErrorCode.ClientHttpAuthentication,
			data: { status: 401 },
		});
		expect(oauthServer.tokenRequests).toHaveLength(2);
		expect(refreshRequest?.parameters.get("grant_type")).toBe("refresh_token");
		expect(refreshRequest?.parameters.get("refresh_token")).toBe("refresh-authorization_code");
		expect(refreshRequest?.parameters.has("scope")).toBe(false);
		expect(oauthServer.mcpAuthorizationHeaders.slice(authorizationOffset)).toEqual([
			"Bearer token-authorization_code",
			"Bearer token-refresh-1",
		]);
	});

	it("spawns and invokes an official stdio server with automatic negotiation", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/echo-stdio-server.mjs", import.meta.url));
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "stdio",
						transport: {
							kind: "stdio",
							command: process.execPath,
							args: [fixture],
							cwd: process.cwd(),
							stderr: "pipe",
						},
					},
				],
			}),
		);

		await runtime.connect("stdio");
		const tools = await runtime.listTools("stdio");
		const result = await runtime.callTool("stdio", {
			name: "echo",
			arguments: { text: "stdio round trip" },
		});

		expect(tools.tools.map(({ name }) => name)).toEqual(["echo"]);
		expect(result.content).toEqual([{ type: "text", text: "stdio round trip" }]);
		expect(runtime.snapshot("stdio")).toMatchObject({
			state: "connected",
			transportKind: "stdio",
			protocolEra: "modern",
			negotiatedProtocolVersion: MODERN_PROTOCOL_VERSION,
		});
	});

	it("spawns and invokes a legacy stdio server after automatic fallback", async () => {
		const fixture = fileURLToPath(
			new URL("./fixtures/echo-legacy-stdio-server.mjs", import.meta.url),
		);
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "legacy-stdio",
						transport: {
							kind: "stdio",
							command: process.execPath,
							args: [fixture],
							cwd: process.cwd(),
							stderr: "pipe",
						},
					},
				],
			}),
		);

		await runtime.connect("legacy-stdio");
		const tools = await runtime.listTools("legacy-stdio");
		const result = await runtime.callTool("legacy-stdio", {
			name: "echo",
			arguments: { text: "legacy stdio round trip" },
		});

		expect(tools.tools.map(({ name }) => name)).toEqual(["echo"]);
		expect(result.content).toEqual([{ type: "text", text: "legacy stdio round trip" }]);
		expect(runtime.snapshot("legacy-stdio")).toMatchObject({
			state: "connected",
			transportKind: "stdio",
			protocolEra: "legacy",
			negotiatedProtocolVersion: LEGACY_PROTOCOL_VERSION,
		});
	});

	it("exercises resources, prompts, completion, and change streams over modern HTTP", async () => {
		const notification = deferred<void>();
		const bus = new InMemoryServerEventBus();
		const handler = trackHandler(
			createMcpHandler(createCapabilityMcpServer, {
				bus,
				keepAliveMs: 0,
				legacy: "reject",
			}),
		);
		const server = await trackServer(startMcpHttpServer(handler));
		const runtime = trackRuntime(
			new McpClientRuntime({
				servers: [
					{
						name: "capabilities",
						transport: { kind: "http", url: server.url },
						configureClient(client) {
							client.setNotificationHandler("notifications/tools/list_changed", () => {
								notification.resolve();
							});
						},
					},
				],
			}),
		);

		await runtime.connect("capabilities");
		const resources = await runtime.listResources("capabilities");
		const templates = await runtime.listResourceTemplates("capabilities");
		const direct = await runtime.readResource("capabilities", { uri: "fixture://status" });
		const templated = await runtime.readResource("capabilities", {
			uri: "fixture://profiles/alice",
		});
		const prompts = await runtime.listPrompts("capabilities");
		const completion = await runtime.complete("capabilities", {
			ref: { type: "ref/prompt", name: "review-code" },
			argument: { name: "language", value: "ty" },
		});
		const prompt = await runtime.getPrompt("capabilities", {
			name: "review-code",
			arguments: { language: "typescript", code: "const answer = 42;" },
		});
		expect(resources.resources.map(({ uri }) => uri)).toEqual(["fixture://status"]);
		expect(templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate)).toEqual([
			"fixture://profiles/{name}",
		]);
		expect(direct.contents).toEqual([
			{ uri: "fixture://status", mimeType: "text/plain", text: "ready" },
		]);
		expect(templated.contents).toEqual([
			{ uri: "fixture://profiles/alice", text: "Hello, alice!" },
		]);
		expect(prompts.prompts.map(({ name }) => name)).toEqual(["review-code"]);
		expect(completion.completion.values).toContain("typescript");
		expect(prompt.messages).toEqual([
			{
				role: "user",
				content: {
					type: "text",
					text: "Review this typescript code: const answer = 42;",
				},
			},
		]);

		const subscription = await runtime.listen("capabilities", { toolsListChanged: true });
		expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
		expect(runtime.activeSubscriptions("capabilities")).toEqual([subscription]);
		expect(bus.listenerCount).toBe(1);
		handler.notify.toolsChanged();
		await notification.promise;
		await subscription.close();
		await expect(subscription.closed).resolves.toBe("local");
		expect(runtime.activeSubscriptions("capabilities")).toEqual([]);
		expect(bus.listenerCount).toBe(0);
	});
});

interface StartedHttpServer {
	readonly url: URL;
	close(): Promise<void>;
}

interface StartedLegacyHttpServer extends StartedHttpServer {
	readonly sessionId: string | undefined;
}

interface StartMcpHttpServerOptions {
	readonly authorize?: (authorization: string | null) => boolean;
	readonly challenge?: string;
	readonly observedAuthorization?: Array<string | null>;
}

interface TokenRequest {
	readonly authorization: string | null;
	readonly parameters: URLSearchParams;
}

interface OAuthTokenState {
	readonly acceptedAccessTokens: Set<string>;
	readonly rejectedAccessTokens: Set<string>;
	currentRefreshToken: string | undefined;
	refreshCount: number;
}

interface PendingAuthorization {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly resource: string;
	readonly codeChallenge: string;
}

interface OAuthMcpServer extends StartedHttpServer {
	readonly issuer: string;
	readonly tokenRequests: TokenRequest[];
	readonly mcpAuthorizationHeaders: Array<string | null>;
	readonly resourceMetadataRequests: number;
	readonly authorizationMetadataRequests: number;
	revokeAccessToken(token: string): void;
	rejectAccessToken(token: string): void;
}

function createEchoHandler(
	name: string,
	contexts: McpRequestContext[] = [],
	options: { readonly legacy?: "stateless" | "reject" } = {},
): McpHttpHandler {
	return createMcpHandler((context) => {
		contexts.push(context);
		return createEchoMcpServer(name);
	}, options);
}

function createEchoMcpServer(name: string): McpServer {
	const server = new McpServer({ name, version: "1.0.0" });
	server.registerTool(
		"echo",
		{
			description: "Echoes text through an interoperability fixture.",
			inputSchema: z.object({ text: z.string() }),
		},
		({ text }) => ({ content: [{ type: "text", text }] }),
	);
	return server;
}

function createCapabilityMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "capability-http", version: "1.0.0" },
		{ capabilities: { tools: { listChanged: true } } },
	);
	server.registerResource(
		"status",
		"fixture://status",
		{ description: "Fixture status", mimeType: "text/plain" },
		async (uri) => ({
			contents: [{ uri: uri.href, mimeType: "text/plain", text: "ready" }],
		}),
	);
	server.registerResource(
		"profile",
		new ResourceTemplate("fixture://profiles/{name}", { list: undefined }),
		{ description: "A greeting for a profile" },
		async (uri, variables) => ({
			contents: [{ uri: uri.href, text: `Hello, ${String(variables.name)}!` }],
		}),
	);
	server.registerPrompt(
		"review-code",
		{
			description: "Review a code sample",
			argsSchema: z.object({
				language: completable(z.string(), (value) =>
					["python", "typescript", "rust"].filter((language) => language.startsWith(value)),
				),
				code: z.string(),
			}),
		},
		async ({ language, code }) => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: `Review this ${language} code: ${code}` },
				},
			],
		}),
	);
	return server;
}

function startBearerMcpHttpServer(
	handler: McpHttpHandler,
	validToken: string,
	observedAuthorization: Array<string | null>,
): Promise<StartedHttpServer> {
	return startMcpHttpServer(handler, {
		authorize: (authorization) => authorization === "Bearer " + validToken,
		challenge: 'Bearer realm="mcp"',
		observedAuthorization,
	});
}

async function startMcpHttpServer(
	handler: McpHttpHandler,
	options: StartMcpHttpServerOptions = {},
): Promise<StartedHttpServer> {
	const nodeHandler = toNodeHandler(handler);
	const validateHost = localhostHostValidation();
	const validateOrigin = localhostOriginValidation();
	const server = createHttpServer((request, response) => {
		if (!validateHost(request, response) || !validateOrigin(request, response)) return;
		if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
			response.writeHead(404);
			response.end();
			return;
		}
		const authorization = headerValue(request.headers.authorization);
		options.observedAuthorization?.push(authorization);
		if (options.authorize !== undefined && !options.authorize(authorization)) {
			response.writeHead(401, {
				"content-type": "text/plain",
				"www-authenticate": options.challenge ?? 'Bearer realm="mcp"',
			});
			response.end("Unauthorized");
			return;
		}
		void nodeHandler(toIncomingMessageLike(request), toServerResponseLike(response)).catch(
			(error: unknown) => {
				response.destroy(toError(error));
			},
		);
	});
	const url = await listen(server);
	return {
		url: new URL("/mcp", url),
		close: () => closeServer(server),
	};
}

async function startLegacyMcpHttpServer(): Promise<StartedLegacyHttpServer> {
	const mcpServer = createEchoMcpServer("legacy-http");
	const transport = new NodeStreamableHTTPServerTransport({
		sessionIdGenerator: randomUUID,
	});
	await mcpServer.connect(transport);
	const validateHost = localhostHostValidation();
	const validateOrigin = localhostOriginValidation();
	const server = createHttpServer((request, response) => {
		if (!validateHost(request, response) || !validateOrigin(request, response)) return;
		if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
			response.writeHead(404);
			response.end();
			return;
		}
		void transport.handleRequest(request, response).catch((error: unknown) => {
			response.destroy(toError(error));
		});
	});
	try {
		const url = await listen(server);
		return {
			url: new URL("/mcp", url),
			get sessionId() {
				return transport.sessionId;
			},
			close: async () => {
				const failures: unknown[] = [];
				try {
					await closeServer(server);
				} catch (error) {
					failures.push(error);
				}
				try {
					await mcpServer.close();
				} catch (error) {
					failures.push(error);
				}
				if (failures.length > 0) {
					throw new AggregateError(failures, "Legacy HTTP fixture cleanup failed.");
				}
			},
		};
	} catch (error) {
		await mcpServer.close();
		throw error;
	}
}

async function createOAuthMcpServer(handler: McpHttpHandler): Promise<OAuthMcpServer> {
	const nodeHandler = toNodeHandler(handler);
	const tokenRequests: TokenRequest[] = [];
	const mcpAuthorizationHeaders: Array<string | null> = [];
	const tokenState: OAuthTokenState = {
		acceptedAccessTokens: new Set<string>(),
		rejectedAccessTokens: new Set<string>(),
		currentRefreshToken: undefined,
		refreshCount: 0,
	};
	const pendingAuthorizations = new Map<string, PendingAuthorization>();
	let issuer = "";
	let resourceOrigin = "";
	let resourceMetadataRequests = 0;
	let authorizationMetadataRequests = 0;
	const validateAuthorizationHost = localhostHostValidation();
	const validateAuthorizationOrigin = localhostOriginValidation();
	const authorizationServer = createHttpServer((request, response) => {
		if (
			!validateAuthorizationHost(request, response) ||
			!validateAuthorizationOrigin(request, response)
		) {
			return;
		}
		const requestUrl = new URL(request.url ?? "/", issuer);
		if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
			authorizationMetadataRequests += 1;
			writeJson(response, 200, {
				issuer,
				authorization_endpoint: issuer + "/authorize",
				token_endpoint: issuer + "/token",
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
				code_challenge_methods_supported: ["S256"],
				scopes_supported: [OAUTH_SCOPE],
				authorization_response_iss_parameter_supported: true,
			});
			return;
		}
		if (requestUrl.pathname === "/authorize") {
			authorize(requestUrl, response, issuer, resourceOrigin + "/mcp", pendingAuthorizations);
			return;
		}
		if (requestUrl.pathname === "/token") {
			void issueToken(
				request,
				response,
				resourceOrigin + "/mcp",
				tokenRequests,
				tokenState,
				pendingAuthorizations,
			);
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const authorizationUrl = await listen(authorizationServer);
	issuer = authorizationUrl.origin;

	const validateResourceHost = localhostHostValidation();
	const validateResourceOrigin = localhostOriginValidation();
	const resourceServer = createHttpServer((request, response) => {
		if (!validateResourceHost(request, response) || !validateResourceOrigin(request, response)) {
			return;
		}
		const requestUrl = new URL(request.url ?? "/", resourceOrigin);
		if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
			resourceMetadataRequests += 1;
			writeJson(response, 200, {
				resource: resourceOrigin + "/mcp",
				authorization_servers: [issuer],
				scopes_supported: [OAUTH_SCOPE],
				bearer_methods_supported: ["header"],
			});
			return;
		}
		if (requestUrl.pathname !== "/mcp") {
			response.writeHead(404);
			response.end();
			return;
		}
		const authorization = headerValue(request.headers.authorization);
		mcpAuthorizationHeaders.push(authorization);
		const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
		if (token === undefined || !tokenState.acceptedAccessTokens.has(token)) {
			const challengeParameters = [
				...(token === undefined ? [] : ['error="invalid_token"']),
				'resource_metadata="' + resourceOrigin + '/.well-known/oauth-protected-resource/mcp"',
				'scope="' + OAUTH_SCOPE + '"',
			];
			response.writeHead(401, {
				"content-type": "text/plain",
				"www-authenticate": "Bearer " + challengeParameters.join(", "),
			});
			response.end("Unauthorized");
			return;
		}
		void nodeHandler(toIncomingMessageLike(request), toServerResponseLike(response)).catch(
			(error: unknown) => {
				response.destroy(toError(error));
			},
		);
	});
	let resourceUrl: URL;
	try {
		resourceUrl = await listen(resourceServer);
		resourceOrigin = resourceUrl.origin;
	} catch (error) {
		await closeServer(authorizationServer);
		throw error;
	}
	return {
		url: new URL("/mcp", resourceUrl),
		issuer,
		tokenRequests,
		mcpAuthorizationHeaders,
		get resourceMetadataRequests() {
			return resourceMetadataRequests;
		},
		get authorizationMetadataRequests() {
			return authorizationMetadataRequests;
		},
		revokeAccessToken(token) {
			tokenState.acceptedAccessTokens.delete(token);
		},
		rejectAccessToken(token) {
			tokenState.rejectedAccessTokens.add(token);
			tokenState.acceptedAccessTokens.delete(token);
		},
		close: async () => {
			const failures: unknown[] = [];
			for (const server of [resourceServer, authorizationServer]) {
				try {
					await closeServer(server);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, "OAuth fixture cleanup failed.");
			}
		},
	};
}

function authorize(
	requestUrl: URL,
	response: ServerResponse,
	issuer: string,
	resourceUrl: string,
	pending: Map<string, PendingAuthorization>,
): void {
	const clientId = requestUrl.searchParams.get("client_id");
	const redirectUri = requestUrl.searchParams.get("redirect_uri");
	const resource = requestUrl.searchParams.get("resource");
	const codeChallenge = requestUrl.searchParams.get("code_challenge");
	if (
		clientId !== INTERACTIVE_CLIENT_ID ||
		redirectUri !== INTERACTIVE_REDIRECT_URI ||
		resource !== resourceUrl ||
		codeChallenge === null ||
		requestUrl.searchParams.get("code_challenge_method") !== "S256" ||
		requestUrl.searchParams.get("response_type") !== "code"
	) {
		writeJson(response, 400, { error: "invalid_request" });
		return;
	}
	pending.set(AUTHORIZATION_CODE, { clientId, redirectUri, resource, codeChallenge });
	const callback = new URL(redirectUri);
	callback.searchParams.set("code", AUTHORIZATION_CODE);
	callback.searchParams.set("state", requestUrl.searchParams.get("state") ?? "");
	callback.searchParams.set("iss", issuer);
	response.writeHead(302, { location: callback.href });
	response.end();
}

async function issueToken(
	request: IncomingMessage,
	response: ServerResponse,
	resourceUrl: string,
	requests: TokenRequest[],
	tokenState: OAuthTokenState,
	pending: Map<string, PendingAuthorization>,
): Promise<void> {
	try {
		const parameters = new URLSearchParams(await readBody(request));
		const authorization = headerValue(request.headers.authorization);
		requests.push({ authorization, parameters });
		const grantType = parameters.get("grant_type");
		if (parameters.get("resource") !== resourceUrl) {
			writeJson(response, 400, {
				error: "invalid_target",
				error_description: "The MCP resource indicator is required.",
			});
			return;
		}
		let accessToken: string;
		let refreshToken: string | undefined;
		if (grantType === "client_credentials") {
			const expected =
				"Basic " + Buffer.from(MACHINE_CLIENT_ID + ":" + MACHINE_CLIENT_SECRET).toString("base64");
			if (authorization !== expected) {
				response.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": 'Basic realm="token"',
				});
				response.end(JSON.stringify({ error: "invalid_client" }));
				return;
			}
			accessToken = "token-client_credentials";
		} else if (grantType === "authorization_code") {
			const code = parameters.get("code");
			const grant = code === null ? undefined : pending.get(code);
			const verifier = parameters.get("code_verifier");
			if (
				code === null ||
				grant === undefined ||
				verifier === null ||
				parameters.get("client_id") !== grant.clientId ||
				parameters.get("redirect_uri") !== grant.redirectUri ||
				parameters.get("resource") !== grant.resource ||
				createHash("sha256").update(verifier).digest("base64url") !== grant.codeChallenge
			) {
				writeJson(response, 400, { error: "invalid_grant" });
				return;
			}
			pending.delete(code);
			accessToken = "token-authorization_code";
			refreshToken = "refresh-authorization_code";
			tokenState.currentRefreshToken = refreshToken;
		} else if (grantType === "refresh_token") {
			if (
				authorization !== null ||
				parameters.get("client_id") !== INTERACTIVE_CLIENT_ID ||
				parameters.get("refresh_token") !== tokenState.currentRefreshToken
			) {
				writeJson(response, 400, { error: "invalid_grant" });
				return;
			}
			const requestedScopes = parameters.getAll("scope");
			if (
				requestedScopes.length > 1 ||
				(requestedScopes.length === 1 && requestedScopes[0] !== OAUTH_SCOPE)
			) {
				writeJson(response, 400, { error: "invalid_scope" });
				return;
			}
			tokenState.currentRefreshToken = undefined;
			tokenState.refreshCount += 1;
			accessToken = "token-refresh-" + String(tokenState.refreshCount);
			refreshToken = "refresh-rotated-" + String(tokenState.refreshCount);
			tokenState.currentRefreshToken = refreshToken;
		} else {
			writeJson(response, 400, { error: "unsupported_grant_type" });
			return;
		}
		if (!tokenState.rejectedAccessTokens.has(accessToken)) {
			tokenState.acceptedAccessTokens.add(accessToken);
		}
		writeJson(
			response,
			200,
			{
				access_token: accessToken,
				token_type: "Bearer",
				expires_in: 3600,
				scope: OAUTH_SCOPE,
				...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
			},
			{ "cache-control": "no-store", pragma: "no-cache" },
		);
	} catch (error) {
		response.destroy(toError(error));
	}
}

async function completeInteractiveAuthorization(
	runtime: McpClientRuntime,
	serverName: string,
	oauthServer: OAuthMcpServer,
	provider: InteractiveOAuthProvider,
): Promise<void> {
	const connectFailure = await captureFailure(runtime.connect(serverName));
	if (!UnauthorizedError.isInstance(connectFailure)) {
		throw new Error("The interactive OAuth connection did not request authorization.");
	}
	const authorizationUrl = provider.authorizationUrl;
	if (authorizationUrl === undefined) throw new Error("OAuth redirect was not captured.");
	const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
	const callbackLocation = authorizationResponse.headers.get("location");
	if (callbackLocation === null) throw new Error("OAuth callback redirect was not returned.");
	const callbackUrl = new URL(callbackLocation);
	if (callbackUrl.searchParams.get("state") !== provider.authorizationState) {
		throw new Error("OAuth callback state did not match.");
	}
	const authorizationCode = callbackUrl.searchParams.get("code");
	const issuer = callbackUrl.searchParams.get("iss");
	if (authorizationCode === null || issuer === null) {
		throw new Error("OAuth callback was missing its code or issuer.");
	}
	const result = await auth(provider, {
		serverUrl: oauthServer.url,
		authorizationCode,
		iss: issuer,
	});
	if (result !== "AUTHORIZED") throw new Error("OAuth authorization did not complete.");
}

class InteractiveOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl = new URL(INTERACTIVE_REDIRECT_URI);
	readonly clientMetadata: OAuthClientMetadata = {
		client_name: "MCP interoperability test client",
		redirect_uris: [this.redirectUrl.href],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope: OAUTH_SCOPE,
	};
	authorizationUrl: URL | undefined;
	authorizationState = "";
	savedCodeVerifier = "";
	#clientInformation: StoredOAuthClientInformation;
	#tokens: StoredOAuthTokens | undefined;
	#discoveryState: OAuthDiscoveryState | undefined;

	constructor(issuer: string) {
		this.#clientInformation = {
			client_id: INTERACTIVE_CLIENT_ID,
			issuer,
		};
	}

	state(): string {
		this.authorizationState = randomUUID();
		return this.authorizationState;
	}

	clientInformation(): StoredOAuthClientInformation {
		return this.#clientInformation;
	}

	saveClientInformation(
		clientInformation: StoredOAuthClientInformation,
		_context?: OAuthClientInformationContext,
	): void {
		this.#clientInformation = clientInformation;
	}

	tokens(): StoredOAuthTokens | undefined {
		return this.#tokens;
	}

	saveTokens(tokens: StoredOAuthTokens): void {
		this.#tokens = tokens;
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.authorizationUrl = new URL(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.savedCodeVerifier = codeVerifier;
	}

	codeVerifier(): string {
		if (this.savedCodeVerifier.length === 0) {
			throw new Error("No PKCE verifier was saved.");
		}
		return this.savedCodeVerifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.#discoveryState = state;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#discoveryState;
	}
}

function writeJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
): void {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
	request.setEncoding("utf8");
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

async function listen(server: Server): Promise<URL> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new TypeError("Expected the interoperability server to bind a TCP port.");
	}
	return new URL("http://127.0.0.1:" + String(address.port));
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) resolve();
			else reject(error);
		});
		server.closeAllConnections();
	});
}

function toIncomingMessageLike(request: IncomingMessage): NodeIncomingMessageLike {
	return {
		...(request.method === undefined ? {} : { method: request.method }),
		...(request.url === undefined ? {} : { url: request.url }),
		headers: request.headers,
		[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
	};
}

function toServerResponseLike(response: ServerResponse): NodeServerResponseLike {
	return {
		writeHead: (statusCode, headers) => response.writeHead(statusCode, headers),
		write: (chunk) => response.write(chunk),
		end: (chunk) => response.end(chunk),
		on: (event, listener) =>
			response.on(event, (...arguments_: unknown[]) => listener(...arguments_)),
		destroyed: response.destroyed,
	};
}

function headerValue(value: string | readonly string[] | undefined): string | null {
	if (value === undefined) return null;
	return typeof value === "string" ? value : (value[0] ?? null);
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("Expected the promise to reject.");
	} catch (error) {
		return error;
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function deferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
	readonly reject: (reason?: unknown) => void;
} {
	let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}
