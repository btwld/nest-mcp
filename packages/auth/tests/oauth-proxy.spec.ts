import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createMcpClientIdMetadataResolver,
	McpMemoryOAuthStore,
	McpOAuthProxy,
	McpOAuthSecretKeyring,
	McpUpstreamAdapter,
} from "../src/index.ts";
import type {
	McpClientIdMetadataResolver,
	McpOAuthClient,
	McpOAuthClientResolver,
} from "../src/index.ts";
import { createMcpTestKeyRing } from "../src/testing/index.ts";
import { hashClientSecret } from "../src/proxy/client-secret.ts";

const ISSUER = "https://mcp.example.com";
const RESOURCE = "https://mcp.example.com/mcp";
const UPSTREAM_ISSUER = "https://idp.example.com";
const CLIENT_ID = "https://app.example.com/oauth/client.json";
const REDIRECT_URI = "https://app.example.com/callback";

// A deterministic fake upstream authorization server driven through the SSRF fetch seam.
function fakeUpstream(): {
	readonly fetch: (input: string | URL) => Promise<Response>;
	subject: string;
	issuedCodes: Set<string>;
	refreshCount: number;
} {
	const state = { subject: "upstream-user-1", issuedCodes: new Set<string>(), refreshCount: 0 };
	const fetch = async (input: string | URL) => {
		const url = new URL(input);
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			return json({
				issuer: UPSTREAM_ISSUER,
				authorization_endpoint: `${UPSTREAM_ISSUER}/authorize`,
				token_endpoint: `${UPSTREAM_ISSUER}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			});
		}
		if (url.pathname === "/token") {
			state.refreshCount += url.searchParams.toString().includes("refresh") ? 1 : 0;
			const idToken = makeIdToken(state.subject);
			return json({
				access_token: `upstream-access-${randomBytes(4).toString("hex")}`,
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: `upstream-refresh-${randomBytes(4).toString("hex")}`,
				id_token: idToken,
			});
		}
		return new Response("not found", { status: 404 });
	};
	return { fetch, ...state };
}

function makeIdToken(subject: string): string {
	const header = base64url({ alg: "none", typ: "JWT" });
	const payload = base64url({
		iss: UPSTREAM_ISSUER,
		aud: "proxy-client",
		sub: subject,
		exp: 9_999_999_999,
	});
	return `${header}.${payload}.`;
}

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function makePkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function staticClientResolver(client: McpOAuthClient): McpOAuthClientResolver {
	return { resolveClient: async (id) => (id === client.clientId ? client : undefined) };
}

interface Harness {
	readonly proxy: McpOAuthProxy;
	readonly store: McpMemoryOAuthStore;
	readonly cookies: Map<string, string>;
}

function createHarness(overrides?: {
	readonly clientResolver?: McpOAuthClientResolver;
	readonly cimd?: McpClientIdMetadataResolver;
}): Harness {
	const store = new McpMemoryOAuthStore({ now: () => Date.now() });
	const { ring } = createMcpTestKeyRing({ issuer: ISSUER });
	const upstream = new McpUpstreamAdapter({
		upstream: {
			issuer: UPSTREAM_ISSUER,
			clientId: "proxy-client",
			clientSecret: "proxy-secret",
			scopes: ["openid"],
		},
		fetch: fakeUpstream().fetch,
	});
	const proxy = new McpOAuthProxy({
		issuer: ISSUER,
		resources: [RESOURCE],
		scopesSupported: ["mcp:invoke", "files:read"],
		signingKeys: ring,
		secrets: new McpOAuthSecretKeyring(randomBytes(32)),
		upstream,
		stateStore: store,
		...(overrides?.cimd === undefined ? {} : { cimd: overrides.cimd }),
		...(overrides?.clientResolver === undefined
			? {}
			: { clientResolver: overrides.clientResolver }),
	});
	return { proxy, store, cookies: new Map() };
}

const PUBLIC_CLIENT: McpOAuthClient = {
	clientId: CLIENT_ID,
	clientName: "Example App",
	redirectUris: [REDIRECT_URI],
	tokenEndpointAuthMethod: "none",
	loopbackOnly: false,
	source: "registered",
};

/** Drives authorize → consent → callback and returns the delivered authorization code. */
async function runToCode(
	harness: Harness,
	pkce: { challenge: string },
	options?: { readonly scope?: string; readonly state?: string },
): Promise<{ code: string; state?: string }> {
	const authorizeUrl = new URL(`${ISSUER}/oauth/authorize`);
	authorizeUrl.searchParams.set("client_id", CLIENT_ID);
	authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("resource", RESOURCE);
	if (options?.scope !== undefined) authorizeUrl.searchParams.set("scope", options.scope);
	if (options?.state !== undefined) authorizeUrl.searchParams.set("state", options.state);

	const authorizeResponse = await harness.proxy.authorize(new Request(authorizeUrl.href));
	expect(authorizeResponse.status).toBe(200);
	const sessionCookie = extractCookie(authorizeResponse);
	const consentHtml = await authorizeResponse.text();
	const { tx, csrf } = extractConsentFields(consentHtml);

	const consentResponse = await harness.proxy.handleConsent(
		new Request(`${ISSUER}/oauth/authorize/consent`, {
			method: "POST",
			headers: { origin: ISSUER, cookie: sessionCookie },
		}),
		new URLSearchParams({ tx, csrf, action: "approve" }),
	);
	expect(consentResponse.status).toBe(302);
	const upstreamUrl = new URL(consentResponse.headers.get("location") ?? "");
	const upstreamState = upstreamUrl.searchParams.get("state") ?? "";

	// Simulate the upstream redirecting back with a code + iss.
	const callbackUrl = new URL(`${ISSUER}/oauth/callback`);
	callbackUrl.searchParams.set("code", "upstream-code-123");
	callbackUrl.searchParams.set("state", upstreamState);
	callbackUrl.searchParams.set("iss", UPSTREAM_ISSUER);
	const callbackResponse = await harness.proxy.handleCallback(
		new Request(callbackUrl.href, { headers: { cookie: sessionCookie } }),
	);
	expect(callbackResponse.status).toBe(302);
	const clientRedirect = new URL(callbackResponse.headers.get("location") ?? "");
	const code = clientRedirect.searchParams.get("code");
	if (code === null) throw new Error("Expected an authorization code in the client redirect.");
	const returnedState = clientRedirect.searchParams.get("state");
	return { code, ...(returnedState === null ? {} : { state: returnedState }) };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
async function readJson<T>(response: Response): Promise<T> {
	// json() returns any; the typed binding narrows without an assertion.
	const body: T = await response.json();
	return body;
}

/** RFC 6749 §2.3.1 Basic credentials: both halves are form-urlencoded before base64. */
function basicAuth(clientId: string, secret: string): string {
	const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`;
	return `Basic ${Buffer.from(encoded).toString("base64")}`;
}

/** Returns the full `name=value` pair for the per-transaction session cookie. */
function extractCookie(response: Response): string {
	const header = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
	const match = /(__Host-nest_mcp_authz_[^=;]+)=([^;]+)/.exec(header);
	return match === null ? "" : `${match[1]}=${match[2]}`;
}

function extractConsentFields(html: string): { tx: string; csrf: string } {
	const tx = /name="tx" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
	return { tx, csrf };
}

describe("McpOAuthProxy authorization-code flow", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = createHarness({ clientResolver: staticClientResolver(PUBLIC_CLIENT) });
	});

	it("issues and verifies an access token end to end", async () => {
		const pkce = makePkce();
		const { code, state } = await runToCode(harness, pkce, {
			scope: "mcp:invoke",
			state: "client-state-xyz",
		});
		expect(state).toBe("client-state-xyz");

		const tokenResponse = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(tokenResponse.status).toBe(200);
		const tokens = await readJson<{
			access_token: string;
			refresh_token: string;
			token_type: string;
		}>(tokenResponse);
		expect(tokens.token_type).toBe("Bearer");
		const authInfo = await harness.proxy.verifier.verifyAccessToken(tokens.access_token);
		expect(authInfo.scopes).toEqual(["mcp:invoke"]);
		expect(authInfo.resource?.href).toBe(RESOURCE);
	});

	it("rejects a replayed authorization code", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		const body = () =>
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			});
		const first = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			body(),
		);
		expect(first.status).toBe(200);
		const second = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			body(),
		);
		expect(second.status).toBe(400);
		expect((await readJson<{ error_description: string }>(second)).error_description).toMatch(
			/already used/,
		);
	});

	it("rejects a wrong PKCE verifier", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		const response = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: makePkce().verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(response.status).toBe(400);
	});

	it("does not burn a code when an unauthenticated attacker probes /token first", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		// Attacker replays the code with a wrong PKCE verifier: must be rejected
		// WITHOUT consuming the code (validate-before-take).
		const attack = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: makePkce().verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(attack.status).toBe(400);
		// The legitimate client can still redeem the untouched code.
		const legit = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(legit.status).toBe(200);
	});

	it("requires client_id at the token endpoint", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		const response = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
			}),
		);
		expect(response.status).toBe(400);
		expect((await readJson<{ error: string }>(response)).error).toBe("invalid_client");
	});

	it("rejects a malformed code_challenge at /authorize", async () => {
		const url = new URL(`${ISSUER}/oauth/authorize`);
		url.searchParams.set("client_id", CLIENT_ID);
		url.searchParams.set("redirect_uri", REDIRECT_URI);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("code_challenge", "too-short");
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("resource", RESOURCE);
		const response = await harness.proxy.authorize(new Request(url.href));
		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_request",
		);
	});

	it("maps a store failure to a retryable temporarily_unavailable", async () => {
		const failing = createHarness({ clientResolver: staticClientResolver(PUBLIC_CLIENT) });
		// Force the token store to throw on the first read the token endpoint makes.
		Object.defineProperty(failing.store, "get", {
			value: async () => {
				throw new Error("backend down");
			},
		});
		const response = await failing.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code: "anything",
				redirect_uri: REDIRECT_URI,
				code_verifier: makePkce().verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(response.status).toBe(503);
		expect((await readJson<{ error: string }>(response)).error).toBe("temporarily_unavailable");
	});

	it("requires S256 PKCE and a resource at /authorize", async () => {
		const noPkce = new URL(`${ISSUER}/oauth/authorize`);
		noPkce.searchParams.set("client_id", CLIENT_ID);
		noPkce.searchParams.set("redirect_uri", REDIRECT_URI);
		noPkce.searchParams.set("response_type", "code");
		noPkce.searchParams.set("resource", RESOURCE);
		const missingPkce = await harness.proxy.authorize(new Request(noPkce.href));
		expect(missingPkce.status).toBe(302);
		expect(new URL(missingPkce.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_request",
		);

		const plain = new URL(noPkce.href);
		plain.searchParams.set("code_challenge", "abc");
		plain.searchParams.set("code_challenge_method", "plain");
		const plainResponse = await harness.proxy.authorize(new Request(plain.href));
		expect(new URL(plainResponse.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_request",
		);
	});

	it("renders (not redirects) an unknown client or bad redirect_uri", async () => {
		const unknown = new URL(`${ISSUER}/oauth/authorize`);
		unknown.searchParams.set("client_id", "https://evil.example/client.json");
		unknown.searchParams.set("redirect_uri", REDIRECT_URI);
		const unknownResponse = await harness.proxy.authorize(new Request(unknown.href));
		expect(unknownResponse.status).toBe(400);
		expect(unknownResponse.headers.get("content-type")).toContain("text/html");

		const badRedirect = new URL(`${ISSUER}/oauth/authorize`);
		badRedirect.searchParams.set("client_id", CLIENT_ID);
		badRedirect.searchParams.set("redirect_uri", "https://attacker.example/callback");
		const badRedirectResponse = await harness.proxy.authorize(new Request(badRedirect.href));
		expect(badRedirectResponse.status).toBe(400);
		expect(badRedirectResponse.headers.get("location")).toBeNull();
	});

	it("enforces consent CSRF, session binding, and same-origin", async () => {
		const pkce = makePkce();
		const authorizeUrl = new URL(`${ISSUER}/oauth/authorize`);
		authorizeUrl.searchParams.set("client_id", CLIENT_ID);
		authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("resource", RESOURCE);
		const authorizeResponse = await harness.proxy.authorize(new Request(authorizeUrl.href));
		const cookie = extractCookie(authorizeResponse);
		const { tx, csrf } = extractConsentFields(await authorizeResponse.text());

		// Missing cookie.
		const noCookie = await harness.proxy.handleConsent(
			new Request(`${ISSUER}/oauth/authorize/consent`, {
				method: "POST",
				headers: { origin: ISSUER },
			}),
			new URLSearchParams({ tx, csrf, action: "approve" }),
		);
		expect(noCookie.status).toBe(403);

		// Wrong CSRF.
		const badCsrf = await harness.proxy.handleConsent(
			new Request(`${ISSUER}/oauth/authorize/consent`, {
				method: "POST",
				headers: { origin: ISSUER, cookie },
			}),
			new URLSearchParams({ tx, csrf: "forged", action: "approve" }),
		);
		expect(badCsrf.status).toBe(403);

		// Cross-origin.
		const crossOrigin = await harness.proxy.handleConsent(
			new Request(`${ISSUER}/oauth/authorize/consent`, {
				method: "POST",
				headers: { origin: "https://evil.example", cookie },
			}),
			new URLSearchParams({ tx, csrf, action: "approve" }),
		);
		expect(crossOrigin.status).toBe(403);
	});

	it("rejects a callback whose session cookie does not match", async () => {
		const pkce = makePkce();
		const authorizeUrl = new URL(`${ISSUER}/oauth/authorize`);
		authorizeUrl.searchParams.set("client_id", CLIENT_ID);
		authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("resource", RESOURCE);
		const authorizeResponse = await harness.proxy.authorize(new Request(authorizeUrl.href));
		const cookie = extractCookie(authorizeResponse);
		const { tx, csrf } = extractConsentFields(await authorizeResponse.text());
		const consent = await harness.proxy.handleConsent(
			new Request(`${ISSUER}/oauth/authorize/consent`, {
				method: "POST",
				headers: { origin: ISSUER, cookie },
			}),
			new URLSearchParams({ tx, csrf, action: "approve" }),
		);
		const upstreamState =
			new URL(consent.headers.get("location") ?? "").searchParams.get("state") ?? "";
		const callback = new URL(`${ISSUER}/oauth/callback`);
		callback.searchParams.set("code", "upstream-code");
		callback.searchParams.set("state", upstreamState);
		callback.searchParams.set("iss", UPSTREAM_ISSUER);
		// Attacker without the victim's session cookie.
		const forged = await harness.proxy.handleCallback(
			new Request(callback.href, { headers: { cookie: "__Host-nest_mcp_authz=attacker" } }),
		);
		expect(forged.status).toBe(403);
	});

	it("rotates refresh tokens and revokes the grant family on reuse", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		const tokenResponse = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			}),
		);
		const first = await readJson<{ refresh_token: string }>(tokenResponse);

		const refresh = () =>
			harness.proxy.token(
				new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: first.refresh_token,
					client_id: CLIENT_ID,
				}),
			);
		const rotated = await refresh();
		expect(rotated.status).toBe(200);
		const rotatedBody = await readJson<{ refresh_token: string }>(rotated);
		expect(rotatedBody.refresh_token).not.toBe(first.refresh_token);

		// Reusing the original (now spent) handle is detected and revokes the family.
		const reuse = await refresh();
		expect(reuse.status).toBe(400);
		expect((await readJson<{ error_description: string }>(reuse)).error_description).toMatch(
			/reuse/,
		);

		// The rotated token is now also dead (grant revoked).
		const afterRevoke = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: rotatedBody.refresh_token,
				client_id: CLIENT_ID,
			}),
		);
		expect(afterRevoke.status).toBe(400);
	});

	it("refuses to redeem a code issued to a different client", async () => {
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		const response = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: "https://other.example/client.json",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("authenticates confidential clients at the token endpoint", async () => {
		const secret = "top-secret-value";
		const confidentialClient: McpOAuthClient = {
			...PUBLIC_CLIENT,
			tokenEndpointAuthMethod: "client_secret_basic",
			clientSecretHash: hashClientSecret(secret),
		};
		harness = createHarness({ clientResolver: staticClientResolver(confidentialClient) });
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });

		const noAuth = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			}),
		);
		expect(noAuth.status).toBe(401);

		// The failed (unauthenticated) attempt is rejected before the code is
		// consumed (validate-before-take), so the authenticated attempt succeeds.
		const authed = await harness.proxy.token(
			new Request(`${ISSUER}/oauth/token`, {
				method: "POST",
				headers: { authorization: basicAuth(CLIENT_ID, secret) },
			}),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
			}),
		);
		expect(authed.status).toBe(200);
	});

	it("serves discovery metadata advertising CIMD and S256", () => {
		const metadata = harness.proxy.authorizationServerMetadata;
		expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
		expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
		expect(harness.proxy.jwks().keys.length).toBeGreaterThan(0);
	});
});

describe("McpOAuthProxy with CIMD clients", () => {
	it("resolves a URL client_id through the CIMD resolver", async () => {
		const cimd: McpClientIdMetadataResolver = createMcpClientIdMetadataResolver({
			now: () => Date.now(),
			fetcher: {
				fetchDocument: async () => ({
					status: 200,
					contentType: "application/json",
					cacheControl: "max-age=600",
					body: JSON.stringify({
						client_id: CLIENT_ID,
						client_name: "CIMD App",
						redirect_uris: [REDIRECT_URI],
					}),
				}),
			},
		});
		const harness = createHarness({ cimd });
		const pkce = makePkce();
		const { code } = await runToCode(harness, pkce, { scope: "mcp:invoke" });
		expect(code).toBeTruthy();
	});
});

describe("McpOAuthProxy RFC 8693 token exchange", () => {
	const CONFIDENTIAL_ID = "https://gateway.example/oauth/client.json";
	const SECRET = "gateway-secret-value";

	function harnessWithExchangeClient(): {
		readonly proxy: McpOAuthProxy;
		readonly userClient: McpOAuthClient;
		readonly exchangeClient: McpOAuthClient;
	} {
		const userClient = PUBLIC_CLIENT;
		const exchangeClient: McpOAuthClient = {
			clientId: CONFIDENTIAL_ID,
			clientName: "Gateway",
			redirectUris: ["https://gateway.example/cb"],
			tokenEndpointAuthMethod: "client_secret_basic",
			clientSecretHash: hashClientSecret(SECRET),
			loopbackOnly: false,
			source: "registered",
		};
		const store = new McpMemoryOAuthStore({ now: () => Date.now() });
		const { ring } = createMcpTestKeyRing({ issuer: ISSUER });
		const proxy = new McpOAuthProxy({
			issuer: ISSUER,
			resources: [RESOURCE, "https://mcp.example.com/mcp/upstream"],
			scopesSupported: ["mcp:invoke", "files:read"],
			signingKeys: ring,
			secrets: new McpOAuthSecretKeyring(randomBytes(32)),
			upstream: new McpUpstreamAdapter({
				upstream: {
					issuer: UPSTREAM_ISSUER,
					clientId: "proxy-client",
					clientSecret: "s",
					scopes: ["openid"],
				},
				fetch: fakeUpstream().fetch,
			}),
			stateStore: store,
			clientResolver: {
				resolveClient: async (id) =>
					id === userClient.clientId
						? userClient
						: id === exchangeClient.clientId
							? exchangeClient
							: undefined,
			},
		});
		return { proxy, userClient, exchangeClient };
	}

	async function mintUserToken(proxy: McpOAuthProxy): Promise<string> {
		const pkce = makePkce();
		const { code } = await runToCode(
			{ proxy, store: new McpMemoryOAuthStore({ now: () => Date.now() }), cookies: new Map() },
			pkce,
			{
				scope: "mcp:invoke files:read",
			},
		);
		const response = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: pkce.verifier,
				client_id: CLIENT_ID,
			}),
		);
		return (await readJson<{ access_token: string }>(response)).access_token;
	}

	it("exchanges a subject token for a downscoped token on another resource", async () => {
		const { proxy } = harnessWithExchangeClient();
		const subjectToken = await mintUserToken(proxy);
		const basic = basicAuth(CONFIDENTIAL_ID, SECRET);
		const response = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: "https://mcp.example.com/mcp/upstream",
				scope: "mcp:invoke",
			}),
		);
		expect(response.status).toBe(200);
		const body = await readJson<{
			access_token: string;
			issued_token_type: string;
			refresh_token?: string;
		}>(response);
		expect(body.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
		expect(body.refresh_token).toBeUndefined();
		const exchanged = await proxy.verifier.verifyAccessToken(body.access_token);
		expect(exchanged.resource?.href).toBe("https://mcp.example.com/mcp/upstream");
		expect(exchanged.scopes).toEqual(["mcp:invoke"]);
	});

	it("never issues an exchanged token that outlives its subject token", async () => {
		const { proxy } = harnessWithExchangeClient();
		const subjectToken = await mintUserToken(proxy);
		const subject = await proxy.verifier.verifyAccessToken(subjectToken);
		const basic = basicAuth(CONFIDENTIAL_ID, SECRET);
		const response = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
			}),
		);
		const body = await readJson<{ access_token: string }>(response);
		const exchanged = await proxy.verifier.verifyAccessToken(body.access_token);
		// The exchanged token's expiry never exceeds the subject token's — the
		// exchange→exchange renewal chain cannot extend lifetime.
		expect(exchanged.expiresAt ?? 0).toBeLessThanOrEqual(subject.expiresAt ?? 0);
	});

	it("does not allow scope re-widening beyond the presented subject token", async () => {
		const { proxy } = harnessWithExchangeClient();
		// Mint a user token, then downscope it via a first exchange to just files:read.
		const subjectToken = await mintUserToken(proxy);
		const basic = basicAuth(CONFIDENTIAL_ID, SECRET);
		const narrowed = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
				scope: "files:read",
			}),
		);
		const narrowedToken = (await readJson<{ access_token: string }>(narrowed)).access_token;
		// A second exchange presenting the narrowed token cannot recover mcp:invoke,
		// even though the underlying grant still has it.
		const rewiden = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: narrowedToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
				scope: "mcp:invoke",
			}),
		);
		expect(rewiden.status).toBe(400);
		expect((await readJson<{ error: string }>(rewiden)).error).toBe("invalid_scope");
	});

	it("requires a confidential, authenticated client", async () => {
		const { proxy } = harnessWithExchangeClient();
		const subjectToken = await mintUserToken(proxy);
		// Public client (the original user client) may not perform exchange.
		const asPublic = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST" }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
				client_id: CLIENT_ID,
			}),
		);
		expect(asPublic.status).toBe(400);
		expect((await readJson<{ error: string }>(asPublic)).error).toBe("invalid_client");

		// Confidential client with a wrong secret is rejected.
		const badBasic = basicAuth(CONFIDENTIAL_ID, "wrong");
		const badSecret = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, {
				method: "POST",
				headers: { authorization: badBasic },
			}),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
			}),
		);
		expect(badSecret.status).toBe(401);
	});

	it("rejects a scope escalation and an unknown resource", async () => {
		const { proxy } = harnessWithExchangeClient();
		const subjectToken = await mintUserToken(proxy);
		const basic = basicAuth(CONFIDENTIAL_ID, SECRET);
		const escalate = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: RESOURCE,
				scope: "admin:everything",
			}),
		);
		expect(escalate.status).toBe(400);
		expect((await readJson<{ error: string }>(escalate)).error).toBe("invalid_scope");

		const unknownResource = await proxy.token(
			new Request(`${ISSUER}/oauth/token`, { method: "POST", headers: { authorization: basic } }),
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: subjectToken,
				subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
				resource: "https://other.example/mcp",
			}),
		);
		expect(unknownResource.status).toBe(400);
		expect((await readJson<{ error: string }>(unknownResource)).error).toBe("invalid_target");
	});
});
