import type { FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import type { McpClientOAuthBootstrapCandidate } from "../src/oauth/bootstrap.ts";
import {
	McpClientOAuthDynamicRegistration,
	McpClientOAuthDynamicRegistrationError,
	McpClientOAuthDynamicRegistrationErrorCode,
	type McpClientOAuthDynamicRegistrationEndpointPolicyInput,
} from "../src/oauth/dynamic-registration.ts";

const SERVER_URL = "https://mcp.example.test/mcp";
const RESOURCE_URL = "https://mcp.example.test/mcp";
const ISSUER_URL = "https://issuer.example.test/tenant";
const REGISTRATION_ENDPOINT = "https://login.example.test/oauth/register";
const REDIRECT_URI = "https://platform.example.test/oauth/callback";

describe("McpClientOAuthDynamicRegistration", () => {
	it("performs one policy-approved public-client POST and returns bounded client information", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const policyInputs: McpClientOAuthDynamicRegistrationEndpointPolicyInput[] = [];
		const registration = new McpClientOAuthDynamicRegistration({
			fetch: recordingFetch(requests, async () => jsonResponse(registrationResponse())),
			endpointPolicy(input) {
				policyInputs.push(input);
				input.endpoint.hostname = "mutated.invalid";
				input.issuer.hostname = "mutated.invalid";
				input.serverUrl.hostname = "mutated.invalid";
				input.resource.hostname = "mutated.invalid";
				return true;
			},
		});

		const result = await registration.register({
			candidate: candidate(),
			clientMetadata: {
				clientName: "Nest MCP Platform",
				applicationType: "web",
				redirectUris: [REDIRECT_URI],
				clientUri: "https://platform.example.test",
				contacts: ["security@example.test"],
				softwareId: "nest-mcp-platform",
				softwareVersion: "1.0.0",
			},
			scopes: ["tools:read", "tools:call", "tools:read"],
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(REGISTRATION_ENDPOINT);
		expect(requests[0]?.init).toMatchObject({
			method: "POST",
			redirect: "error",
		});
		expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json");
		const requestBody = requests[0]?.init?.body;
		if (typeof requestBody !== "string") throw new Error("Expected a JSON request body.");
		expect(JSON.parse(requestBody)).toEqual({
			client_name: "Nest MCP Platform",
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			application_type: "web",
			client_uri: "https://platform.example.test/",
			contacts: ["security@example.test"],
			software_id: "nest-mcp-platform",
			software_version: "1.0.0",
			scope: "tools:read tools:call",
		});
		expect(policyInputs).toHaveLength(1);
		expect(policyInputs[0]).toMatchObject({
			exactRegistrationEndpoint: REGISTRATION_ENDPOINT,
			exactIssuer: ISSUER_URL,
			method: "POST",
			credentialed: false,
		});
		expect(result).toEqual({
			issuer: ISSUER_URL,
			client: { clientId: "registered-public-client", authentication: { method: "none" } },
			clientSecret: "non-confidential-public-secret",
			clientIdIssuedAt: 100,
			clientSecretExpiresAt: 0,
			registeredScopes: ["tools:read", "tools:call"],
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.client)).toBe(true);
		expect(Object.isFrozen(result.client.authentication)).toBe(true);
	});

	it("accepts an SDK-compatible 2xx response with only required echoed metadata", async () => {
		const registration = new McpClientOAuthDynamicRegistration({
			fetch: async () =>
				jsonResponse(
					{
						client_id: "minimally-registered-public-client",
						client_secret: "optional-non-confidential-secret",
						redirect_uris: [REDIRECT_URI],
					},
					200,
				),
			endpointPolicy: allowEndpoint,
		});

		await expect(registerDefault(registration)).resolves.toEqual({
			issuer: ISSUER_URL,
			client: {
				clientId: "minimally-registered-public-client",
				authentication: { method: "none" },
			},
			clientSecret: "optional-non-confidential-secret",
		});
	});

	it.each([
		{ name: "claimed HTTPS", redirectUri: "https://native.example.test/oauth/callback" },
		{ name: "loopback HTTP", redirectUri: "http://127.0.0.1:9876/oauth/callback" },
	])(
		"registers an explicitly classified native client with $name redirect",
		async ({ redirectUri }) => {
			const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
			const registration = new McpClientOAuthDynamicRegistration({
				fetch: recordingFetch(requests, async () =>
					jsonResponse(
						registrationResponse({
							application_type: "native",
							redirect_uris: [redirectUri],
						}),
					),
				),
				endpointPolicy: allowEndpoint,
			});

			await registration.register({
				candidate: candidate(),
				clientMetadata: {
					clientName: "Nest MCP Native",
					applicationType: "native",
					redirectUris: [redirectUri],
				},
			});

			const requestBody = requests[0]?.init?.body;
			if (typeof requestBody !== "string") throw new Error("Expected a JSON request body.");
			expect(JSON.parse(requestBody)).toMatchObject({
				application_type: "native",
				redirect_uris: [redirectUri],
			});
		},
	);

	it("rejects a loopback redirect for an explicitly classified web client before dispatch", async () => {
		const fetch = vi.fn<FetchLike>();
		const registration = new McpClientOAuthDynamicRegistration({
			fetch,
			endpointPolicy: allowEndpoint,
		});

		await expect(
			registration.register({
				candidate: candidate(),
				clientMetadata: {
					clientName: "Nest MCP Web",
					applicationType: "web",
					redirectUris: ["http://127.0.0.1:9876/oauth/callback"],
				},
			}),
		).rejects.toMatchObject({ code: McpClientOAuthDynamicRegistrationErrorCode.InvalidOptions });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps DCR unavailable when the ready candidate has no legacy endpoint", async () => {
		const fetch = vi.fn<FetchLike>();
		const endpointPolicy = vi.fn(() => true as const);
		const registration = new McpClientOAuthDynamicRegistration({ fetch, endpointPolicy });
		const withoutDcr = candidate();
		Reflect.deleteProperty(withoutDcr, "legacyDynamicRegistrationEndpoint");

		await expect(
			registration.register({
				candidate: withoutDcr,
				clientMetadata: defaultClientMetadata(),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthDynamicRegistrationErrorCode.Unsupported });
		expect(endpointPolicy).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects DCR before dispatch when the authority cannot consume a public client", async () => {
		const fetch = vi.fn<FetchLike>();
		const endpointPolicy = vi.fn(() => true as const);
		const registration = new McpClientOAuthDynamicRegistration({ fetch, endpointPolicy });

		await expect(
			registration.register({
				candidate: candidate(["client_secret_basic"]),
				clientMetadata: defaultClientMetadata(),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthDynamicRegistrationErrorCode.Unsupported });
		expect(endpointPolicy).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([false, undefined, "true", {}, "throw"] as const)(
		"fails closed before dispatch when policy returns %j",
		async (behavior) => {
			const fetch = vi.fn<FetchLike>();
			const registration = new McpClientOAuthDynamicRegistration({
				fetch,
				endpointPolicy() {
					if (behavior === "throw") throw new Error("policy-secret-marker");
					// Deliberately exercise a misbehaving untyped host policy.
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion
					return behavior as never;
				},
			});

			let thrown: unknown;
			try {
				await registration.register({
					candidate: candidate(),
					clientMetadata: defaultClientMetadata(),
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({
				code: McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected,
			});
			expect(String(thrown)).not.toContain("policy-secret-marker");
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects a redirected response without trusting its destination", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const redirected = jsonResponse(registrationResponse());
		Object.defineProperties(redirected, {
			redirected: { value: true },
			url: { value: "https://evil.example.test/register" },
		});
		const registration = new McpClientOAuthDynamicRegistration({
			fetch: recordingFetch(requests, async () => redirected),
			endpointPolicy: allowEndpoint,
		});

		await expect(registerDefault(registration)).rejects.toMatchObject({
			code: McpClientOAuthDynamicRegistrationErrorCode.EndpointRejected,
			requestDispatched: true,
			retrySafe: false,
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.init?.redirect).toBe("error");
	});

	it("canonicalizes an HTTP rejection without retaining or exposing its body", async () => {
		const marker = "remote-registration-body-secret-marker";
		const registration = new McpClientOAuthDynamicRegistration({
			fetch: async () => jsonResponse({ error: "invalid_client_metadata", marker }, 400),
			endpointPolicy: allowEndpoint,
		});

		let thrown: unknown;
		try {
			await registerDefault(registration);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(McpClientOAuthDynamicRegistrationError);
		expect(thrown).toMatchObject({
			code: McpClientOAuthDynamicRegistrationErrorCode.RegistrationRejected,
			requestDispatched: true,
			retrySafe: false,
		});
		expect(JSON.stringify(thrown)).not.toContain(marker);
		expect(String(thrown)).not.toContain(marker);
	});

	it.each([
		{
			name: "declared oversized body",
			response: () =>
				jsonResponse(registrationResponse(), 201, { "content-length": String(64 * 1_024 + 1) }),
		},
		{
			name: "actual oversized body",
			response: () =>
				new Response(`{"client_id":"${"x".repeat(64 * 1_024)}"}`, {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		},
		{
			name: "invalid JSON",
			response: () =>
				new Response("not-json", {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		},
		{
			name: "unreadable body",
			response: () => unreadableJsonResponse(),
		},
		{
			name: "oversized client id",
			response: () => jsonResponse(registrationResponse({ client_id: "x".repeat(2_049) }), 201),
		},
		{
			name: "oversized client secret",
			response: () => jsonResponse(registrationResponse({ client_secret: "x".repeat(8_193) }), 201),
		},
		{
			name: "redirect URI substitution",
			response: () =>
				jsonResponse(
					registrationResponse({ redirect_uris: ["https://evil.example.test/callback"] }),
					201,
				),
		},
		{
			name: "confidential authentication substitution",
			response: () =>
				jsonResponse(
					registrationResponse({ token_endpoint_auth_method: "client_secret_basic" }),
					201,
				),
		},
		{
			name: "application type substitution",
			response: () => jsonResponse(registrationResponse({ application_type: "native" }), 201),
		},
		{
			name: "authorization-code response type removal",
			response: () => jsonResponse(registrationResponse({ response_types: ["token"] }), 201),
		},
		{
			name: "authorization-code grant removal",
			response: () => jsonResponse(registrationResponse({ grant_types: ["refresh_token"] }), 201),
		},
		{
			name: "non-NQCHAR registered scope",
			response: () => jsonResponse(registrationResponse({ scope: 'tools"read' }), 201),
		},
	])("rejects an $name response without making retry safe", async ({ response }) => {
		const fetch = vi.fn<FetchLike>(async () => response());
		const registration = new McpClientOAuthDynamicRegistration({
			fetch,
			endpointPolicy: allowEndpoint,
		});

		await expect(registerDefault(registration)).rejects.toMatchObject({
			code: McpClientOAuthDynamicRegistrationErrorCode.ResponseInvalid,
			requestDispatched: true,
			retrySafe: false,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("turns a post-dispatch network failure into a non-retryable unknown outcome", async () => {
		const marker = "socket-error-secret-marker";
		const fetch = vi.fn<FetchLike>(async () => {
			throw new Error(marker);
		});
		const registration = new McpClientOAuthDynamicRegistration({
			fetch,
			endpointPolicy: allowEndpoint,
		});

		let thrown: unknown;
		try {
			await registerDefault(registration);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			code: McpClientOAuthDynamicRegistrationErrorCode.OutcomeUnknown,
			requestDispatched: true,
			retrySafe: false,
		});
		expect(String(thrown)).not.toContain(marker);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("distinguishes pre-dispatch cancellation from an ambiguous abort after dispatch", async () => {
		const before = new AbortController();
		before.abort(new DOMException("cancelled-before", "AbortError"));
		const beforeFetch = vi.fn<FetchLike>();
		const registrationBefore = new McpClientOAuthDynamicRegistration({
			fetch: beforeFetch,
			endpointPolicy: allowEndpoint,
		});
		await expect(registerDefault(registrationBefore, before.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(beforeFetch).not.toHaveBeenCalled();

		const during = new AbortController();
		const enteredFetch = deferred<void>();
		const fetch = vi.fn<FetchLike>(async (_input, init) => {
			enteredFetch.resolve(undefined);
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
					once: true,
				});
			});
		});
		const registrationDuring = new McpClientOAuthDynamicRegistration({
			fetch,
			endpointPolicy: allowEndpoint,
		});
		const pending = registerDefault(registrationDuring, during.signal);
		await enteredFetch.promise;
		during.abort(new DOMException("cancelled-during", "AbortError"));

		await expect(pending).rejects.toMatchObject({
			code: McpClientOAuthDynamicRegistrationErrorCode.OutcomeUnknown,
			requestDispatched: true,
			retrySafe: false,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

function candidate(
	tokenEndpointAuthMethodsSupported: readonly string[] = ["none"],
): McpClientOAuthBootstrapCandidate {
	return {
		authority: {
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
			authorizationEndpoint: "https://login.example.test/oauth/authorize",
			tokenEndpoint: "https://login.example.test/oauth/token",
			responseTypesSupported: ["code"],
			codeChallengeMethodsSupported: ["S256"],
			tokenEndpointAuthMethodsSupported,
			authorizationResponseIssuerParameterSupported: true,
		},
		clientIdMetadataDocumentSupported: false,
		legacyDynamicRegistrationEndpoint: REGISTRATION_ENDPOINT,
	};
}

function defaultClientMetadata(): {
	readonly clientName: string;
	readonly applicationType: "web";
	readonly redirectUris: readonly string[];
} {
	return { clientName: "Nest MCP Platform", applicationType: "web", redirectUris: [REDIRECT_URI] };
}

function registrationResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		client_id: "registered-public-client",
		client_secret: "non-confidential-public-secret",
		client_id_issued_at: 100,
		client_secret_expires_at: 0,
		redirect_uris: [REDIRECT_URI],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		application_type: "web",
		scope: "tools:read tools:call",
		...overrides,
	};
}

async function registerDefault(
	registration: McpClientOAuthDynamicRegistration,
	signal?: AbortSignal,
): Promise<unknown> {
	return registration.register({
		candidate: candidate(),
		clientMetadata: defaultClientMetadata(),
		...(signal === undefined ? {} : { signal }),
	});
}

function recordingFetch(
	requests: Array<{ url: string; init: RequestInit | undefined }>,
	handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): FetchLike {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push({ url, init });
		return handler(url, init);
	};
}

function jsonResponse(body: unknown, status = 201, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function unreadableJsonResponse(): Response {
	const response = jsonResponse(registrationResponse());
	Object.defineProperty(response, "text", {
		value: async () => {
			throw new Error("unreadable-response-secret-marker");
		},
	});
	return response;
}

function allowEndpoint(): true {
	return true;
}

function deferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}
