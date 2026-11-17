import { ConfigService } from "@nestjs/config";
import type { AuthProvider, FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { OAuthNetworkPolicyService } from "../src/oauth/oauth-network-policy.service.ts";
import { VolatileOAuthAuthorityService } from "../src/oauth/volatile-oauth-authority.service.ts";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_URL = "https://resource.example.test/mcp";
const ISSUER = "https://auth.example.test";
const AUTHORIZE_URL = `${ISSUER}/authorize`;
const TOKEN_URL = `${ISSUER}/token`;
const REGISTER_URL = `${ISSUER}/register`;

describe("VolatileOAuthAuthorityService", () => {
	it("performs DCR + PKCE, consumes callback state once, and exposes only a minimal runtime bridge", async () => {
		const server = createOAuthServer({
			refresh: (count) => (count === 2 ? json({ error: "invalid_grant" }, 400) : undefined),
		});
		const authority = createAuthority(server.baseFetch);

		const authorizationUrl = await authority.beginAuthorization({
			connectionId: CONNECTION_ID,
			generationKey: "generation-1",
			endpoint: RESOURCE_URL,
		});
		const redirect = new URL(authorizationUrl);
		const state = redirect.searchParams.get("state");
		expect(redirect.origin + redirect.pathname).toBe(AUTHORIZE_URL);
		expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
		expect(state).toBeTruthy();
		expect(authority.view(CONNECTION_ID, "generation-1")).toMatchObject({
			kind: "oauth",
			status: "authorizing",
			scopes: ["mcp:tools", "projects:read"],
			authorizationServerHost: "auth.example.test",
		});

		const callback = new URLSearchParams({ code: "approved-code", state: state! });
		const taken = authority.takeCallback(callback);
		expect(() => authority.takeCallback(callback)).toThrowError(
			expect.objectContaining({ code: "MCP_OAUTH_CALLBACK_INVALID" }),
		);
		const prepared = await authority.exchangeCallback(taken);
		authority.publishAuthorization(prepared, "generation-2");

		const view = authority.view(CONNECTION_ID, "generation-2");
		expect(view).toMatchObject({ status: "authorized", scopes: ["mcp:tools"] });
		expect(JSON.stringify(view)).not.toMatch(
			/access-initial|refresh-initial|volatile-client|approved-code/u,
		);

		const lease = authority.acquireRuntimeBridge("generation-2");
		await expect(lease.authProvider.token()).resolves.toBe("access-initial");
		await lease.authProvider.onUnauthorized?.(unauthorized(server.baseFetch));
		await expect(lease.authProvider.token()).resolves.toBe("access-refreshed");
		expect(authority.view(CONNECTION_ID, "generation-2")).toMatchObject({
			status: "authorized",
			scopes: ["mcp:tools", "projects:read"],
		});

		// A terminal refresh retires the credential generation: the bridge is fenced
		// and this control plane's own taxonomy is asserted on the acquisition seam.
		await expect(
			lease.authProvider.onUnauthorized?.(unauthorized(server.baseFetch)),
		).rejects.toThrow();
		expect(authority.isAuthorized("generation-2")).toBe(false);
		await expect(lease.authProvider.token()).rejects.toThrow();
		expect(() => authority.acquireRuntimeBridge("generation-2")).toThrowError(
			expect.objectContaining({ code: "MCP_OAUTH_AUTHORIZATION_REQUIRED" }),
		);
		expect(authority.view(CONNECTION_ID, "generation-2")).toMatchObject({
			status: "reauthorization-required",
			errorCode: "MCP_OAUTH_AUTHORIZATION_REQUIRED",
		});
		expect(server.tokenBodies.map(grantType)).toEqual([
			"authorization_code",
			"refresh_token",
			"refresh_token",
		]);
		await lease.close();
		authority.fenceGeneration("generation-2");
	});

	it("joins concurrent unauthorized retries on one generation into a single refresh exchange", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = createOAuthServer({
			refresh: async () => {
				await gate;
				return undefined;
			},
		});
		const authority = createAuthority(server.baseFetch);
		await authorizeGeneration(authority);

		const first = authority.acquireRuntimeBridge("generation-2");
		const second = authority.acquireRuntimeBridge("generation-2");
		const retries = Promise.all([
			first.authProvider.onUnauthorized?.(unauthorized(server.baseFetch)),
			second.authProvider.onUnauthorized?.(unauthorized(server.baseFetch)),
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		release?.();
		await retries;

		expect(server.tokenBodies.map(grantType)).toEqual(["authorization_code", "refresh_token"]);
		await expect(first.authProvider.token()).resolves.toBe("access-refreshed");
		await expect(second.authProvider.token()).resolves.toBe("access-refreshed");
		await Promise.all([first.close(), second.close()]);
		authority.fenceGeneration("generation-2");
	});

	it("stops serving a fenced generation without reaching the authorization server", async () => {
		const server = createOAuthServer();
		const authority = createAuthority(server.baseFetch);
		await authorizeGeneration(authority);

		const lease = authority.acquireRuntimeBridge("generation-2");
		authority.fenceGeneration("generation-2");

		expect(authority.isAuthorized("generation-2")).toBe(false);
		await expect(lease.authProvider.token()).rejects.toThrow();
		await expect(
			lease.authProvider.onUnauthorized?.(unauthorized(server.baseFetch)),
		).rejects.toThrow();
		expect(server.tokenBodies.map(grantType)).toEqual(["authorization_code"]);
		await lease.close();
	});

	it("rejects a browser authorization redirect outside the configured OAuth host boundary", () => {
		const network = new OAuthNetworkPolicyService(
			config(),
			vi.fn(async () => new Response(null, { status: 204 })),
		);
		expect(() =>
			network.admitAuthorizationRedirect("https://attacker.example/authorize?state=x", {
				authorizationServerUrl: ISSUER,
				authorizationServerMetadata: {
					issuer: ISSUER,
					authorization_endpoint: "https://attacker.example/authorize",
					token_endpoint: TOKEN_URL,
					response_types_supported: ["code"],
				},
			}),
		).toThrowError(expect.objectContaining({ code: "MCP_OAUTH_ENDPOINT_REJECTED" }));
	});
});

async function authorizeGeneration(authority: VolatileOAuthAuthorityService): Promise<void> {
	const authorizationUrl = await authority.beginAuthorization({
		connectionId: CONNECTION_ID,
		generationKey: "generation-1",
		endpoint: RESOURCE_URL,
	});
	const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
	const taken = authority.takeCallback(new URLSearchParams({ code: "approved-code", state }));
	authority.publishAuthorization(await authority.exchangeCallback(taken), "generation-2");
}

function createAuthority(baseFetch: FetchLike): VolatileOAuthAuthorityService {
	const configuration = config();
	return new VolatileOAuthAuthorityService(
		configuration,
		new OAuthNetworkPolicyService(configuration, baseFetch),
	);
}

/** One in-memory authorization server: RFC 9728 discovery, DCR, and the token endpoint. */
function createOAuthServer(
	options: {
		/** Overrides the response for the nth refresh exchange, or delays it. */
		readonly refresh?: (count: number) => Promise<Response | undefined> | Response | undefined;
	} = {},
): { readonly baseFetch: FetchLike; readonly tokenBodies: readonly string[] } {
	const tokenBodies: string[] = [];
	let refreshCount = 0;
	const baseFetch = vi.fn<FetchLike>(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "resource.example.test" && url.pathname.startsWith("/.well-known/")) {
			return json({
				resource: RESOURCE_URL,
				authorization_servers: [ISSUER],
				scopes_supported: ["mcp:tools", "projects:read"],
			});
		}
		if (url.href.startsWith(`${ISSUER}/.well-known/`)) {
			return json({
				issuer: ISSUER,
				authorization_endpoint: AUTHORIZE_URL,
				token_endpoint: TOKEN_URL,
				registration_endpoint: REGISTER_URL,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				scopes_supported: ["mcp:tools", "projects:read"],
			});
		}
		if (url.href === REGISTER_URL) {
			return json(
				{
					...JSON.parse(bodyText(init?.body, "{}")),
					client_id: "volatile-client",
					token_endpoint_auth_method: "none",
				},
				201,
			);
		}
		if (url.href === TOKEN_URL) {
			const body = bodyText(init?.body, "");
			tokenBodies.push(body);
			const grant = new URLSearchParams(body).get("grant_type");
			if (grant === "refresh_token") {
				refreshCount += 1;
				const override = await options.refresh?.(refreshCount);
				if (override !== undefined) return override;
			}
			return json({
				access_token: grant === "refresh_token" ? "access-refreshed" : "access-initial",
				refresh_token: grant === "refresh_token" ? "refresh-rotated" : "refresh-initial",
				token_type: "Bearer",
				scope: grant === "refresh_token" ? "mcp:tools projects:read" : "mcp:tools",
			});
		}
		throw new Error("Unexpected OAuth test URL.");
	});
	return { baseFetch, tokenBodies };
}

function unauthorized(
	fetchFn: FetchLike,
): Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0] {
	return {
		response: new Response(null, { status: 401 }),
		serverUrl: new URL(RESOURCE_URL),
		fetchFn,
	};
}

function grantType(body: string): string | null {
	return new URLSearchParams(body).get("grant_type");
}

function config(): ControlPlaneConfigService {
	return new ControlPlaneConfigService(
		new ConfigService({
			MCP_ALLOWED_HOSTS: ["resource.example.test"],
			MCP_OAUTH_ALLOWED_HOSTS: ["auth.example.test"],
			CONTROL_PLANE_OAUTH_CALLBACK_URL: "http://127.0.0.1:5173/api/v1/mcp/oauth/callback",
			MCP_OAUTH_TRANSACTION_TTL_MS: 600_000,
			MCP_MAX_CONNECTIONS: 16,
			MCP_REQUEST_TIMEOUT_MS: 10_000,
		}),
	);
}

function bodyText(body: BodyInit | null | undefined, fallback: string): string {
	if (body == null) return fallback;
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	throw new TypeError("OAuth fixture expected a textual request body.");
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}
