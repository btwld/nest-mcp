import { createHash } from "node:crypto";

import type { AddClientAuthentication, FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
	McpClientOAuthProtocol,
	McpClientOAuthProtocolError,
	McpClientOAuthProtocolErrorCode,
	type McpClientOAuthAuthority,
	type McpClientOAuthAuthorizationTransaction,
	type McpClientOAuthClient,
	type McpClientOAuthEndpointPolicy,
	type McpClientOAuthEndpointPolicyInput,
} from "../src/oauth/protocol.ts";
import { isInternalMcpClientOAuthProtocolError } from "../src/oauth/protocol-error-brand.ts";
import {
	McpOAuthStateErrorCode,
	createOAuthState,
	createOAuthStateLookupDigest,
} from "../src/oauth/state.ts";

const SERVER_URL = "https://mcp.example.test/api/mcp";
const RESOURCE_URL = "https://mcp.example.test/api/mcp";
const ISSUER_URL = "https://issuer.example.test/tenant";
const AUTHORIZATION_ENDPOINT = "https://login.example.test/oauth/authorize?audience=mcp";
const TOKEN_ENDPOINT = "https://login.example.test/oauth/token?tenant=artifact";
const RESOURCE_METADATA_ENDPOINT =
	"https://mcp.example.test/.well-known/oauth-protected-resource/api/mcp";
const ROOT_RESOURCE_METADATA_ENDPOINT =
	"https://mcp.example.test/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_ENDPOINT =
	"https://issuer.example.test/.well-known/oauth-authorization-server/tenant";
const REGISTRATION_ENDPOINT = "https://login.example.test/oauth/register";
const REDIRECT_URI = "https://studio.example.test/oauth/callback?installation=one";

interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | undefined;
	readonly redirect: RequestRedirect | undefined;
	readonly signal: AbortSignal | null | undefined;
}

interface PolicyObservation {
	readonly endpoint: string;
	readonly kind: McpClientOAuthEndpointPolicyInput["kind"];
	readonly credentialed: boolean;
	readonly resource: string;
	readonly issuer: string;
	readonly signal: AbortSignal | undefined;
}

describe("McpClientOAuthProtocol discovery", () => {
	it("binds exact resource and issuer metadata, policies every generated endpoint, and excludes DCR", async () => {
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const fetch = recordingFetch(requests, async (request) => {
			switch (request.url) {
				case RESOURCE_METADATA_ENDPOINT:
					return jsonResponse(protectedResourceMetadata());
				case AUTHORIZATION_SERVER_METADATA_ENDPOINT:
					return jsonResponse(authorizationServerMetadata());
				default:
					throw new Error(`Unexpected test request: ${request.url}`);
			}
		});
		const endpointPolicy: McpClientOAuthEndpointPolicy = async (input) => {
			policyCalls.push(observePolicy(input));
			// Policy receives disposable URL copies; mutation must not redirect the operation.
			input.endpoint.hostname = "policy-mutated.invalid";
			input.resource.hostname = "policy-resource-mutated.invalid";
			input.issuer.hostname = "policy-issuer-mutated.invalid";
			return true;
		};
		const protocol = new McpClientOAuthProtocol({ fetch, endpointPolicy });

		const authority = await protocol.discover({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
		});

		expect(authority).toEqual(defaultAuthority());
		expect(requests.map((request) => request.url)).toEqual([
			RESOURCE_METADATA_ENDPOINT,
			AUTHORIZATION_SERVER_METADATA_ENDPOINT,
		]);
		expect(requests.every((request) => request.redirect === "error")).toBe(true);
		expect(requests.every((request) => request.url !== REGISTRATION_ENDPOINT)).toBe(true);
		expect(policyCalls).toEqual([
			policyObservation(RESOURCE_METADATA_ENDPOINT, "resource-metadata", false),
			policyObservation(
				AUTHORIZATION_SERVER_METADATA_ENDPOINT,
				"authorization-server-metadata",
				false,
			),
			policyObservation(AUTHORIZATION_ENDPOINT, "authorization", false),
			policyObservation(TOKEN_ENDPOINT, "token", true),
		]);
	});

	it("applies policy and redirect:error independently to discovery fallback endpoints", async () => {
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async (request) => {
				if (request.url === RESOURCE_METADATA_ENDPOINT) return jsonResponse({}, 404);
				if (request.url === ROOT_RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(protectedResourceMetadata());
				}
				if (request.url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(authorizationServerMetadata());
				}
				throw new Error(`Unexpected test request: ${request.url}`);
			}),
			endpointPolicy: recordPolicy(policyCalls),
		});

		await protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL });

		expect(requests.map((request) => request.url)).toEqual([
			RESOURCE_METADATA_ENDPOINT,
			ROOT_RESOURCE_METADATA_ENDPOINT,
			AUTHORIZATION_SERVER_METADATA_ENDPOINT,
		]);
		expect(requests.every((request) => request.redirect === "error")).toBe(true);
		expect(policyCalls.slice(0, 3).map((call) => call.endpoint)).toEqual(
			requests.map((request) => request.url),
		);
	});

	it.each([
		{
			name: "resource identifier",
			resourceMetadata: protectedResourceMetadata({ resource: "https://other.example.test/mcp" }),
		},
		{
			name: "authorization-server selection",
			resourceMetadata: protectedResourceMetadata({
				authorization_servers: ["https://other-issuer.example.test"],
			}),
		},
	])(
		"rejects an inexact $name before authorization-server discovery",
		async ({ resourceMetadata }) => {
			const requests: RecordedRequest[] = [];
			const protocol = new McpClientOAuthProtocol({
				fetch: recordingFetch(requests, async () => jsonResponse(resourceMetadata)),
				endpointPolicy: allowEndpoint,
			});

			await expect(
				protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
			).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
			expect(requests).toHaveLength(1);
		},
	);

	it("rejects an inexact issuer echo from authorization-server metadata", async () => {
		const requests: RecordedRequest[] = [];
		const protocol = discoveryProtocol(requests, {
			authorizationMetadata: authorizationServerMetadata({
				issuer: "https://issuer.example.test/other-tenant",
			}),
		});

		await expect(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
		).rejects.toSatisfy((error: unknown) =>
			hasProtocolCode(error, [
				McpClientOAuthProtocolErrorCode.AuthorityInvalid,
				McpClientOAuthProtocolErrorCode.DiscoveryFailed,
			]),
		);
		expect(requests).toHaveLength(2);
	});

	it.each([
		{ name: "omitted", supported: undefined },
		{ name: "false", supported: false },
	] as const)(
		"accepts $name RFC 9207 authorization-response issuer capability",
		async ({ supported }) => {
			const requests: RecordedRequest[] = [];
			const protocol = discoveryProtocol(requests, {
				authorizationMetadata: authorizationServerMetadata({
					authorization_response_iss_parameter_supported: supported,
				}),
			});

			await expect(
				protocol.discover({
					serverUrl: SERVER_URL,
					resource: RESOURCE_URL,
					issuer: ISSUER_URL,
				}),
			).resolves.toMatchObject({
				authorizationResponseIssuerParameterSupported: false,
			});
			expect(requests).toHaveLength(2);
		},
	);

	it.each([
		{
			name: "authorization-code response type",
			metadata: authorizationServerMetadata({ response_types_supported: ["token"] }),
		},
		{
			name: "PKCE S256",
			metadata: authorizationServerMetadata({ code_challenge_methods_supported: ["plain"] }),
		},
		{
			name: "explicit token authentication",
			metadata: authorizationServerMetadata({ token_endpoint_auth_methods_supported: [] }),
		},
	])("requires $name in discovered metadata", async ({ metadata }) => {
		const protocol = discoveryProtocol([], { authorizationMetadata: metadata });
		await expect(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
	});

	it.each([
		{
			name: "protected resource metadata without header bearer transport",
			metadata: protectedResourceMetadata({ bearer_methods_supported: ["body"] }),
		},
		{
			name: "DPoP-bound access tokens",
			metadata: protectedResourceMetadata({ dpop_bound_access_tokens_required: true }),
		},
		{
			name: "mutual-TLS-bound access tokens",
			metadata: protectedResourceMetadata({
				tls_client_certificate_bound_access_tokens: true,
			}),
		},
	])("rejects $name before authorization-server discovery", async ({ metadata }) => {
		const requests: RecordedRequest[] = [];
		const protocol = discoveryProtocol(requests, { resourceMetadata: metadata });

		await expect(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
		expect(requests).toHaveLength(1);
	});

	it("returns a deeply frozen, bounded snapshot and drops unknown and registration metadata", async () => {
		const protocol = discoveryProtocol([], {
			authorizationMetadata: {
				...authorizationServerMetadata(),
				response_types_supported: ["code", "code"],
				code_challenge_methods_supported: ["S256", "S256"],
				registration_endpoint: REGISTRATION_ENDPOINT,
				jwks_uri: "https://login.example.test/.well-known/jwks.json",
				unknown_secret_shaped_metadata: "must-not-survive",
			},
		});

		const authority = await protocol.discover({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
		});

		expect(Object.isFrozen(authority)).toBe(true);
		expect(Object.isFrozen(authority.responseTypesSupported)).toBe(true);
		expect(Object.isFrozen(authority.codeChallengeMethodsSupported)).toBe(true);
		expect(Object.isFrozen(authority.tokenEndpointAuthMethodsSupported)).toBe(true);
		expect(authority.responseTypesSupported).toEqual(["code"]);
		expect(authority.codeChallengeMethodsSupported).toEqual(["S256"]);
		expect(Object.keys(authority)).not.toContain("registrationEndpoint");
		expect(Object.keys(authority)).not.toContain("registration_endpoint");
		expect(JSON.stringify(authority)).not.toContain(REGISTRATION_ENDPOINT);
		expect(JSON.stringify(authority)).not.toContain("unknown_secret_shaped_metadata");
	});

	it.each([
		{
			name: "more than 256 entries",
			values: Array.from({ length: 257 }, (_, index) => `method-${String(index)}`),
		},
		{ name: "an oversized entry", values: ["x".repeat(2_049)] },
		{ name: "a control-containing entry", values: ["client_secret_basic\nother"] },
	])("rejects metadata lists containing $name", async ({ values }) => {
		const protocol = discoveryProtocol([], {
			authorizationMetadata: authorizationServerMetadata({
				token_endpoint_auth_methods_supported: values,
			}),
		});
		await expect(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
	});

	it.each(["false", "undefined", "truthy-string", "truthy-object", "throw"] as const)(
		"fails closed when endpoint policy returns %s",
		async (behavior) => {
			const requests: RecordedRequest[] = [];
			const policy: McpClientOAuthEndpointPolicy = async () => {
				if (behavior === "throw") throw new Error("policy-internal-marker");
				// Runtime fail-closed behavior intentionally covers an untyped/misbehaving host policy.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				if (behavior === "undefined") return undefined as never;
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				if (behavior === "truthy-string") return "true" as never;
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				if (behavior === "truthy-object") return {} as never;
				return false;
			};
			const protocol = new McpClientOAuthProtocol({
				fetch: recordingFetch(requests, async () => jsonResponse(protectedResourceMetadata())),
				endpointPolicy: policy,
			});

			let thrown: unknown;
			try {
				await protocol.discover({
					serverUrl: SERVER_URL,
					resource: RESOURCE_URL,
					issuer: ISSUER_URL,
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({ code: McpClientOAuthProtocolErrorCode.EndpointRejected });
			expect(String(thrown)).not.toContain("policy-internal-marker");
			expect(requests).toHaveLength(0);
		},
	);

	it("canonicalizes a protocol-error spoof thrown by the host fetch", async () => {
		const marker = "host-fetch-custom-message-secret-marker";
		const spoof = new McpClientOAuthProtocolError(
			McpClientOAuthProtocolErrorCode.InvalidGrant,
			marker,
		);
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => {
				throw spoof;
			},
			endpointPolicy: allowEndpoint,
		});

		const thrown = await expectSafeProtocolFailure(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
			McpClientOAuthProtocolErrorCode.DiscoveryFailed,
			[marker],
		);
		expect(isInternalMcpClientOAuthProtocolError(spoof)).toBe(false);
		expect(isInternalMcpClientOAuthProtocolError(thrown)).toBe(true);
		expect(thrown).not.toBe(spoof);
	});

	it("rejects redirected metadata responses", async () => {
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => redirectedJsonResponse(protectedResourceMetadata()),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			protocol.discover({ serverUrl: SERVER_URL, resource: RESOURCE_URL, issuer: ISSUER_URL }),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.EndpointRejected });
	});

	it("propagates cancellation while discovery endpoint policy is pending", async () => {
		const controller = new AbortController();
		const enteredPolicy = deferred<void>();
		const releasePolicy = deferred<boolean>();
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => jsonResponse(protectedResourceMetadata())),
			endpointPolicy: async () => {
				enteredPolicy.resolve();
				return releasePolicy.promise;
			},
		});
		const discovery = protocol.discover({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
			signal: controller.signal,
		});
		await enteredPolicy.promise;
		controller.abort(new DOMException("cancelled", "AbortError"));
		releasePolicy.resolve(true);

		await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
		expect(requests).toHaveLength(0);
	});

	it("propagates cancellation while a metadata fetch is pending", async () => {
		const controller = new AbortController();
		const enteredFetch = deferred<void>();
		const releaseFetch = deferred<Response>();
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => {
				enteredFetch.resolve();
				return releaseFetch.promise;
			}),
			endpointPolicy: allowEndpoint,
		});
		const discovery = protocol.discover({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
			signal: controller.signal,
		});
		await enteredFetch.promise;
		controller.abort(new DOMException("cancelled", "AbortError"));
		releaseFetch.resolve(jsonResponse(protectedResourceMetadata()));

		await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.signal?.aborted).toBe(true);
	});
});

describe("McpClientOAuthProtocol authorization transactions", () => {
	it("supports native loopback HTTP redirects through authorization and token exchange", async () => {
		const redirectUri = "http://127.0.0.1:5173/api/mcp/oauth/callback";
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: allowEndpoint,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri,
		});
		const authorizationUrl = new URL(started.authorizationUrl);
		const state = requireParameter(authorizationUrl, "state");
		expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);

		await protocol.exchangeAuthorization({
			transaction: started.transaction,
			client: noneClient(),
			callback: new URLSearchParams({ code: "loopback-code", state, iss: ISSUER_URL }),
		});
		const request = expectSingleTokenRequest(requests);
		expect(new URLSearchParams(request.body).get("redirect_uri")).toBe(redirectUri);
	});

	it("rejects a non-loopback HTTP redirect before endpoint policy", async () => {
		const endpointPolicy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
		const protocol = new McpClientOAuthProtocol({ fetch: unexpectedFetch, endpointPolicy });

		await expect(
			protocol.startAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				redirectUri: "http://platform.example.test/oauth/callback",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
		expect(endpointPolicy).not.toHaveBeenCalled();
	});

	it("returns digest-only state and a deeply pinned transaction with a matching S256 challenge", async () => {
		const policyCalls: PolicyObservation[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: unexpectedFetch,
			endpointPolicy: recordPolicy(policyCalls),
			now: () => 1_234_567,
		});
		const responseTypes = ["code"];
		const authMethods = ["client_secret_post"];
		const mutableAuthority = defaultAuthority({
			responseTypesSupported: responseTypes,
			tokenEndpointAuthMethodsSupported: authMethods,
		});
		const client = secretPostClient("client-one", "client-secret-marker");

		const started = await protocol.startAuthorization({
			authority: mutableAuthority,
			client,
			redirectUri: REDIRECT_URI,
			scopes: ["tools:read", "offline_access", "tools:read"],
		});
		const authorizationUrl = new URL(started.authorizationUrl);
		const state = requireParameter(authorizationUrl, "state");
		const challenge = requireParameter(authorizationUrl, "code_challenge");
		const independentlyDerivedChallenge = createHash("sha256")
			.update(started.transaction.codeVerifier, "ascii")
			.digest("base64url");

		expect(started.transaction.stateDigest).toBe(createOAuthStateLookupDigest(state));
		expect(started.transaction.authorityDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(Object.keys(started.transaction)).not.toContain("state");
		expect(JSON.stringify(started.transaction)).not.toContain(state);
		expect(JSON.stringify(started.transaction)).not.toContain("client-secret-marker");
		expect(challenge).toBe(independentlyDerivedChallenge);
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
			new URL(AUTHORIZATION_ENDPOINT).origin + new URL(AUTHORIZATION_ENDPOINT).pathname,
		);
		expect(authorizationUrl.searchParams.get("audience")).toBe("mcp");
		expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizationUrl.searchParams.get("client_id")).toBe("client-one");
		expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(authorizationUrl.searchParams.get("resource")).toBe(RESOURCE_URL);
		expect(authorizationUrl.searchParams.get("scope")).toBe("tools:read offline_access");
		expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
		expect(started.transaction).toMatchObject({
			redirectUri: REDIRECT_URI,
			clientId: "client-one",
			clientAuthenticationMethod: "client_secret_post",
			scope: "tools:read offline_access",
			createdAtMs: 1_234_567,
		});
		expect(started.transaction.authority).toEqual(mutableAuthority);
		expect(started.transaction.authority).not.toBe(mutableAuthority);
		expect(Object.isFrozen(started)).toBe(true);
		expect(Object.isFrozen(started.transaction)).toBe(true);
		expect(Object.isFrozen(started.transaction.authority)).toBe(true);
		expect(Object.isFrozen(started.transaction.authority.responseTypesSupported)).toBe(true);
		expect(policyCalls).toEqual([
			policyObservation(AUTHORIZATION_ENDPOINT, "authorization", false),
		]);

		responseTypes[0] = "token";
		authMethods[0] = "none";
		Object.assign(mutableAuthority, {
			authorizationEndpoint: "https://swapped.example.test/authorize",
			tokenEndpoint: "https://swapped.example.test/token",
		});
		expect(started.transaction.authority).toEqual(
			defaultAuthority({
				responseTypesSupported: ["code"],
				tokenEndpointAuthMethodsSupported: ["client_secret_post"],
			}),
		);
	});

	it.each([
		{ name: "omitted", supported: undefined },
		{ name: "a truthy non-boolean", supported: "true" },
	] as const)(
		"rejects a manually supplied authority with invalid RFC 9207 capability $name",
		async ({ supported }) => {
			const authority = defaultAuthority();
			Object.defineProperty(authority, "authorizationResponseIssuerParameterSupported", {
				value: supported,
			});
			const endpointPolicy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
			const protocol = new McpClientOAuthProtocol({ fetch: unexpectedFetch, endpointPolicy });

			await expect(
				protocol.startAuthorization({
					authority,
					client: noneClient(),
					redirectUri: REDIRECT_URI,
				}),
			).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
			expect(endpointPolicy).not.toHaveBeenCalled();
		},
	);

	it("accepts a manually supplied authority without RFC 9207 response-issuer support", async () => {
		const endpointPolicy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
		const protocol = new McpClientOAuthProtocol({ fetch: unexpectedFetch, endpointPolicy });

		await expect(
			protocol.startAuthorization({
				authority: defaultAuthority({
					authorizationResponseIssuerParameterSupported: false,
				}),
				client: noneClient(),
				redirectUri: REDIRECT_URI,
			}),
		).resolves.toMatchObject({ transaction: { authority: { issuer: ISSUER_URL } } });
		expect(endpointPolicy).toHaveBeenCalledOnce();
	});

	it("rejects a manual authority that omits authorization_code from advertised grants", async () => {
		const endpointPolicy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
		const protocol = new McpClientOAuthProtocol({ fetch: unexpectedFetch, endpointPolicy });

		await expect(
			protocol.startAuthorization({
				authority: defaultAuthority({ grantTypesSupported: ["refresh_token"] }),
				client: noneClient(),
				redirectUri: REDIRECT_URI,
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.AuthorityInvalid });
		expect(endpointPolicy).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "empty string", malformedScopes: "" },
		{ name: "zero-length array-like object", malformedScopes: { length: 0 } },
	] as const)(
		"rejects an untyped $name scope collection before policy",
		async ({ malformedScopes }) => {
			const endpointPolicy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
			const protocol = new McpClientOAuthProtocol({ fetch: unexpectedFetch, endpointPolicy });
			const input = {
				authority: defaultAuthority(),
				client: noneClient(),
				redirectUri: REDIRECT_URI,
			};
			Reflect.set(input, "scopes", malformedScopes);

			await expect(protocol.startAuthorization(input)).rejects.toMatchObject({
				code: McpClientOAuthProtocolErrorCode.InvalidOptions,
			});
			expect(endpointPolicy).not.toHaveBeenCalled();
		},
	);

	it("redeems the exact callback code, PKCE verifier, redirect, resource, client, and token endpoint", async () => {
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: recordPolicy(policyCalls),
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient("exact-client"),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");
		policyCalls.length = 0;

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient("exact-client"),
				callback: new URLSearchParams({
					code: "exact-authorization-code",
					state,
					iss: ISSUER_URL,
				}),
			}),
		).resolves.toMatchObject({
			access_token: "access-token",
			refresh_token: "rotated-refresh-token",
		});

		const request = expectSingleTokenRequest(requests);
		const body = new URLSearchParams(request.body);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("exact-authorization-code");
		expect(body.get("code_verifier")).toBe(started.transaction.codeVerifier);
		expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(body.get("resource")).toBe(RESOURCE_URL);
		expect(body.get("client_id")).toBe("exact-client");
		expect(policyCalls).toEqual([
			policyObservation(TOKEN_ENDPOINT, "token", true),
			policyObservation(TOKEN_ENDPOINT, "token", true),
		]);
	});

	it("retains the pinned requested scope when an exchange response omits scope", async () => {
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => jsonResponse({ access_token: "access-token", token_type: "Bearer" }),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
			scopes: ["tools:read"],
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient(),
				callback: successfulCallback(state),
			}),
		).resolves.toMatchObject({ scope: "tools:read" });
	});

	it("accepts an explicit server-default scope when authorization requested no scope", async () => {
		const protocol = new McpClientOAuthProtocol({
			fetch: async () =>
				jsonResponse({ access_token: "access-token", token_type: "Bearer", scope: "tools:read" }),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient(),
				callback: successfulCallback(state),
			}),
		).resolves.toMatchObject({ scope: "tools:read" });
	});

	it("rejects an exchange response that widens the pinned requested scope", async () => {
		const protocol = new McpClientOAuthProtocol({
			fetch: async () =>
				jsonResponse({ access_token: "access-token", token_type: "Bearer", scope: "tools:write" }),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
			scopes: ["tools:read"],
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient(),
				callback: successfulCallback(state),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.TokenExchangeFailed });
	});

	it("never reveals the authorization grant, PKCE verifier, redirect, or resource to a private_key_jwt signer", async () => {
		const authorizationCode = "authorization-code-secret-marker";
		let codeVerifier = "not-created";
		const requests: RecordedRequest[] = [];
		const addClientAuthentication = vi.fn<AddClientAuthentication>(
			async (headers, parameters, url, metadata) => {
				expect([...headers]).toEqual([]);
				expect([...parameters]).toEqual([["client_id", "exchange-jwt-client"]]);
				const signerView = JSON.stringify({
					headers: [...headers],
					parameters: [...parameters],
					url: String(url),
					metadata,
				});
				for (const secret of [authorizationCode, codeVerifier, REDIRECT_URI, RESOURCE_URL]) {
					expect(signerView).not.toContain(secret);
				}
				for (const grantParameter of [
					"grant_type",
					"code",
					"code_verifier",
					"redirect_uri",
					"resource",
				]) {
					expect(parameters.has(grantParameter)).toBe(false);
				}
				parameters.set(
					"client_assertion_type",
					"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
				);
				parameters.set("client_assertion", "exchange-signed-assertion");
			},
		);
		const client: McpClientOAuthClient = {
			clientId: "exchange-jwt-client",
			authentication: { method: "private_key_jwt", addClientAuthentication },
		};
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority({
				tokenEndpointAuthMethodsSupported: ["private_key_jwt"],
			}),
			client,
			redirectUri: REDIRECT_URI,
		});
		codeVerifier = started.transaction.codeVerifier;
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await protocol.exchangeAuthorization({
			transaction: started.transaction,
			client,
			callback: new URLSearchParams({ code: authorizationCode, state, iss: ISSUER_URL }),
		});

		expect(addClientAuthentication).toHaveBeenCalledOnce();
		const body = new URLSearchParams(expectSingleTokenRequest(requests).body);
		expect(body.get("code")).toBe(authorizationCode);
		expect(body.get("code_verifier")).toBe(codeVerifier);
		expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(body.get("resource")).toBe(RESOURCE_URL);
		expect(body.get("client_assertion")).toBe("exchange-signed-assertion");
	});

	it.each([
		{ method: "none", supported: ["client_secret_post"] },
		{ method: "client_secret_basic", supported: ["none", "client_secret_post"] },
		{ method: "client_secret_post", supported: ["none", "client_secret_basic"] },
	] as const)(
		"rejects unadvertised explicit client authentication $method",
		async ({ method, supported }) => {
			const protocol = new McpClientOAuthProtocol({
				fetch: unexpectedFetch,
				endpointPolicy: allowEndpoint,
			});
			const authentication = method === "none" ? { method } : { method, clientSecret: "secret" };
			await expect(
				protocol.startAuthorization({
					authority: defaultAuthority({ tokenEndpointAuthMethodsSupported: supported }),
					client: { clientId: "client", authentication },
					redirectUri: REDIRECT_URI,
				}),
			).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.ClientUnsupported });
		},
	);

	it("validates duplicate, denial, state, expiry, and issuer callbacks before policy or network", async () => {
		let nowMs = 10_000;
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: recordPolicy(policyCalls),
			authorizationTransactionTtlMs: 1_000,
			now: () => nowMs,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");
		policyCalls.length = 0;

		const cases: readonly {
			readonly name: string;
			readonly callback: URLSearchParams;
			readonly code: string;
			readonly marker?: string;
		}[] = [
			{
				name: "duplicate state",
				callback: parametersWithDuplicateState(state),
				code: McpOAuthStateErrorCode.InvalidCallback,
			},
			{
				name: "authorization denial",
				callback: new URLSearchParams({
					error: "access_denied",
					error_description: "remote-denial-secret-marker",
					state,
					iss: ISSUER_URL,
				}),
				code: McpClientOAuthProtocolErrorCode.AuthorizationDenied,
				marker: "remote-denial-secret-marker",
			},
			{
				name: "mismatched state",
				callback: successfulCallback(createOAuthState()),
				code: McpOAuthStateErrorCode.StateMismatch,
			},
			{
				name: "missing mandatory issuer",
				callback: new URLSearchParams({ code: "authorization-code", state }),
				code: McpClientOAuthProtocolErrorCode.TransactionInvalid,
			},
			{
				name: "wrong issuer",
				callback: successfulCallback(state, "https://attacker.example.test"),
				code: McpClientOAuthProtocolErrorCode.TransactionInvalid,
			},
		];

		for (const testCase of cases) {
			let thrown: unknown;
			try {
				await protocol.exchangeAuthorization({
					transaction: started.transaction,
					client: noneClient(),
					callback: testCase.callback,
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown, testCase.name).toMatchObject({ code: testCase.code });
			if (testCase.marker !== undefined) {
				expect(String(thrown), testCase.name).not.toContain(testCase.marker);
			}
			expect(policyCalls, testCase.name).toHaveLength(0);
			expect(requests, testCase.name).toHaveLength(0);
		}

		nowMs = 11_000;
		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient(),
				callback: successfulCallback(state),
			}),
		).rejects.toMatchObject({ code: McpOAuthStateErrorCode.StateExpired });
		expect(policyCalls).toHaveLength(0);
		expect(requests).toHaveLength(0);
	});

	it.each([
		{ name: "an omitted issuer", callbackIssuer: undefined },
		{ name: "the exact issuer", callbackIssuer: ISSUER_URL },
	] as const)(
		"accepts $name when RFC 9207 response-issuer support was not advertised",
		async ({ callbackIssuer }) => {
			const requests: RecordedRequest[] = [];
			const protocol = new McpClientOAuthProtocol({
				fetch: recordingFetch(requests, async () => tokenResponse()),
				endpointPolicy: allowEndpoint,
				now: () => 100,
			});
			const started = await protocol.startAuthorization({
				authority: defaultAuthority({
					authorizationResponseIssuerParameterSupported: false,
				}),
				client: noneClient(),
				redirectUri: REDIRECT_URI,
			});
			const state = requireParameter(new URL(started.authorizationUrl), "state");
			const callback = new URLSearchParams({ code: "authorization-code", state });
			if (callbackIssuer !== undefined) callback.set("iss", callbackIssuer);

			await expect(
				protocol.exchangeAuthorization({
					transaction: started.transaction,
					client: noneClient(),
					callback,
				}),
			).resolves.toMatchObject({ access_token: "access-token" });
			expect(requests).toHaveLength(1);
		},
	);

	it("rejects a mismatched issuer even when RFC 9207 response-issuer support was not advertised", async () => {
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority({
				authorizationResponseIssuerParameterSupported: false,
			}),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: noneClient(),
				callback: successfulCallback(state, "https://attacker.example.test"),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.TransactionInvalid });
		expect(requests).toHaveLength(0);
	});

	it("rejects transaction client, authentication, and pinned endpoint swaps before network", async () => {
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: recordPolicy(policyCalls),
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");
		policyCalls.length = 0;

		const swappedTransactions: readonly McpClientOAuthAuthorizationTransaction[] = [
			{ ...started.transaction, clientId: "other-client" },
			{ ...started.transaction, clientAuthenticationMethod: "client_secret_post" },
			{
				...started.transaction,
				authority: {
					...started.transaction.authority,
					tokenEndpoint: "https://attacker.example.test/oauth/token",
				},
			},
			{
				...started.transaction,
				authority: {
					...started.transaction.authority,
					authorizationEndpoint: "https://attacker.example.test/oauth/authorize",
				},
			},
		];

		for (const transaction of swappedTransactions) {
			await expect(
				protocol.exchangeAuthorization({
					transaction,
					client: noneClient(),
					callback: successfulCallback(state),
				}),
			).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.TransactionInvalid });
			expect(policyCalls).toHaveLength(0);
			expect(requests).toHaveLength(0);
		}

		await expect(
			protocol.exchangeAuthorization({
				transaction: started.transaction,
				client: { clientId: "other-client", authentication: { method: "none" } },
				callback: successfulCallback(state),
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.TransactionInvalid });
		expect(policyCalls).toHaveLength(0);
		expect(requests).toHaveLength(0);
	});

	it("never requests a registration endpoint during start and exchange", async () => {
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async (request) => {
				if (request.url === REGISTRATION_ENDPOINT) {
					throw new Error("Dynamic Client Registration must not be requested");
				}
				return tokenResponse();
			}),
			endpointPolicy: allowEndpoint,
			now: () => 100,
		});
		const started = await protocol.startAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			redirectUri: REDIRECT_URI,
		});
		const state = requireParameter(new URL(started.authorizationUrl), "state");

		await protocol.exchangeAuthorization({
			transaction: started.transaction,
			client: noneClient(),
			callback: successfulCallback(state),
		});

		expect(requests.map((request) => request.url)).toEqual([TOKEN_ENDPOINT]);
		expect(requests.some((request) => request.url === REGISTRATION_ENDPOINT)).toBe(false);
	});
});

describe("McpClientOAuthProtocol token requests", () => {
	it("requires the authority to explicitly advertise the refresh_token grant", async () => {
		const requests: RecordedRequest[] = [];
		const protocol = tokenProtocol(requests);
		const { grantTypesSupported: _grantTypesSupported, ...authority } = defaultAuthority();

		await expect(
			protocol.refreshAuthorization({
				authority,
				client: noneClient(),
				refreshToken: "refresh-secret-marker",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.ClientUnsupported });
		expect(requests).toHaveLength(0);
	});

	it("uses client_secret_basic with UTF-8 form encoding and no body credential", async () => {
		const requests: RecordedRequest[] = [];
		const clientId = "cliënt +:%";
		const clientSecret = "sëcret +:%";
		const protocol = tokenProtocol(requests);

		await protocol.refreshAuthorization({
			authority: defaultAuthority({ tokenEndpointAuthMethodsSupported: ["client_secret_basic"] }),
			client: basicClient(clientId, clientSecret),
			refreshToken: "refresh-token",
		});

		const request = expectSingleTokenRequest(requests);
		const expectedUsername = formEncode(clientId);
		const expectedPassword = formEncode(clientSecret);
		expect(request.headers.get("authorization")).toBe(
			`Basic ${Buffer.from(`${expectedUsername}:${expectedPassword}`, "utf8").toString("base64")}`,
		);
		const body = new URLSearchParams(request.body);
		expect(body.get("client_id")).toBeNull();
		expect(body.get("client_secret")).toBeNull();
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh-token");
		expect(body.get("resource")).toBe(RESOURCE_URL);
	});

	it.each(["none", "client_secret_post"] as const)(
		"uses exactly the configured %s authentication method",
		async (method) => {
			const requests: RecordedRequest[] = [];
			const protocol = tokenProtocol(requests);
			const client =
				method === "none"
					? noneClient("public-client")
					: secretPostClient("post-client", "post-secret");

			await protocol.refreshAuthorization({
				authority: defaultAuthority({
					tokenEndpointAuthMethodsSupported: ["client_secret_basic", "client_secret_post", "none"],
				}),
				client,
				refreshToken: "refresh-token",
			});

			const request = expectSingleTokenRequest(requests);
			const body = new URLSearchParams(request.body);
			expect(request.headers.get("authorization")).toBeNull();
			expect(body.get("client_id")).toBe(client.clientId);
			expect(body.get("client_secret")).toBe(method === "none" ? null : "post-secret");
		},
	);

	it("gives private_key_jwt an isolated auth-only view and copies only its assertion fields", async () => {
		const requests: RecordedRequest[] = [];
		const refreshToken = "refresh-token-secret-marker";
		const addClientAuthentication = vi.fn<AddClientAuthentication>(
			async (headers, parameters, url, metadata) => {
				expect([...headers]).toEqual([]);
				expect([...parameters]).toEqual([["client_id", "jwt-client"]]);
				expect(String(url)).toBe(TOKEN_ENDPOINT);
				expect(metadata).toMatchObject({
					issuer: ISSUER_URL,
					token_endpoint: TOKEN_ENDPOINT,
					token_endpoint_auth_methods_supported: ["private_key_jwt"],
				});
				expect(metadata === undefined || "registration_endpoint" in metadata).toBe(false);
				const signerView = JSON.stringify({
					headers: [...headers],
					parameters: [...parameters],
					url: String(url),
					metadata,
				});
				expect(signerView).not.toContain(refreshToken);
				expect(parameters.has("grant_type")).toBe(false);
				expect(parameters.has("refresh_token")).toBe(false);
				expect(parameters.has("resource")).toBe(false);

				// Endpoint and metadata objects are disposable; signer mutation cannot redirect the request.
				if (url instanceof URL) url.hostname = "signer-mutated.invalid";
				if (metadata !== undefined) {
					Reflect.set(metadata, "token_endpoint", "https://signer-mutated.invalid/token");
				}
				parameters.set(
					"client_assertion_type",
					"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
				);
				parameters.set("client_assertion", "signed-assertion-marker");
			},
		);
		const protocol = tokenProtocol(requests);

		await protocol.refreshAuthorization({
			authority: defaultAuthority({ tokenEndpointAuthMethodsSupported: ["private_key_jwt"] }),
			client: {
				clientId: "jwt-client",
				authentication: { method: "private_key_jwt", addClientAuthentication },
			},
			refreshToken,
		});

		expect(addClientAuthentication).toHaveBeenCalledOnce();
		const request = expectSingleTokenRequest(requests);
		expect(request.headers.get("authorization")).toBeNull();
		const body = new URLSearchParams(request.body);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe(refreshToken);
		expect(body.get("resource")).toBe(RESOURCE_URL);
		expect(body.get("client_id")).toBe("jwt-client");
		expect(body.get("client_assertion_type")).toBe(
			"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		);
		expect(body.get("client_assertion")).toBe("signed-assertion-marker");
	});

	it.each([
		{
			name: "a conflicting client_id",
			mutate: (_headers: Headers, parameters: URLSearchParams) => {
				parameters.set("client_id", "other-client");
			},
		},
		{
			name: "a duplicate client_id",
			mutate: (_headers: Headers, parameters: URLSearchParams) => {
				parameters.append("client_id", "jwt-client");
			},
		},
		{
			name: "a duplicate assertion type",
			mutate: (_headers: Headers, parameters: URLSearchParams) => {
				parameters.append(
					"client_assertion_type",
					"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
				);
			},
		},
		{
			name: "a duplicate assertion",
			mutate: (_headers: Headers, parameters: URLSearchParams) => {
				parameters.append("client_assertion", "duplicate-assertion-secret-marker");
			},
		},
		{
			name: "an unexpected parameter",
			mutate: (_headers: Headers, parameters: URLSearchParams) => {
				parameters.set("refresh_token", "signer-injected-secret-marker");
			},
		},
		{
			name: "a conflicting Authorization header",
			mutate: (headers: Headers) => {
				headers.set("Authorization", "Basic signer-header-secret-marker");
			},
		},
		{
			name: "an unexpected header",
			mutate: (headers: Headers) => {
				headers.set("X-Signer-Header", "signer-header-secret-marker");
			},
		},
	] as const)("rejects private_key_jwt signer output containing $name", async ({ mutate }) => {
		const requests: RecordedRequest[] = [];
		const addClientAuthentication = vi.fn<AddClientAuthentication>(async (headers, parameters) => {
			parameters.set(
				"client_assertion_type",
				"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			);
			parameters.set("client_assertion", "valid-assertion");
			mutate(headers, parameters);
		});
		const protocol = tokenProtocol(requests);

		const thrown = await expectSafeProtocolFailure(
			protocol.refreshAuthorization({
				authority: defaultAuthority({
					tokenEndpointAuthMethodsSupported: ["private_key_jwt"],
				}),
				client: {
					clientId: "jwt-client",
					authentication: { method: "private_key_jwt", addClientAuthentication },
				},
				refreshToken: "refresh-token-secret-marker",
			}),
			McpClientOAuthProtocolErrorCode.ClientUnsupported,
			[
				"refresh-token-secret-marker",
				"duplicate-assertion-secret-marker",
				"signer-injected-secret-marker",
				"signer-header-secret-marker",
			],
		);
		expect(thrown.code).toBe(McpClientOAuthProtocolErrorCode.ClientUnsupported);
		expect(requests).toHaveLength(0);
	});

	it("policies the exact token endpoint before invoking a secret producer", async () => {
		const requests: RecordedRequest[] = [];
		const addClientAuthentication = vi.fn<AddClientAuthentication>(async () => undefined);
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: async () => false,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority({ tokenEndpointAuthMethodsSupported: ["private_key_jwt"] }),
				client: {
					clientId: "jwt-client",
					authentication: { method: "private_key_jwt", addClientAuthentication },
				},
				refreshToken: "refresh-secret-marker",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.EndpointRejected });
		expect(addClientAuthentication).not.toHaveBeenCalled();
		expect(requests).toHaveLength(0);
	});

	it("canonicalizes a protocol-error spoof thrown by endpoint policy", async () => {
		const marker = "endpoint-policy-custom-message-secret-marker";
		const spoof = new McpClientOAuthProtocolError(
			McpClientOAuthProtocolErrorCode.InvalidGrant,
			marker,
		);
		const protocol = new McpClientOAuthProtocol({
			fetch: unexpectedFetch,
			endpointPolicy: async () => {
				throw spoof;
			},
		});

		const thrown = await expectSafeProtocolFailure(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "policy-refresh-secret-marker",
			}),
			McpClientOAuthProtocolErrorCode.EndpointRejected,
			[marker, "policy-refresh-secret-marker"],
		);
		expect(isInternalMcpClientOAuthProtocolError(spoof)).toBe(false);
		expect(isInternalMcpClientOAuthProtocolError(thrown)).toBe(true);
		expect(thrown).not.toBe(spoof);
	});

	it("canonicalizes a protocol-error spoof thrown by a private_key_jwt signer", async () => {
		const marker = "signer-custom-message-secret-marker";
		const spoof = new McpClientOAuthProtocolError(
			McpClientOAuthProtocolErrorCode.InvalidClient,
			marker,
		);
		const requests: RecordedRequest[] = [];
		const addClientAuthentication = vi.fn<AddClientAuthentication>(async () => {
			throw spoof;
		});
		const protocol = tokenProtocol(requests);

		const thrown = await expectSafeProtocolFailure(
			protocol.refreshAuthorization({
				authority: defaultAuthority({
					tokenEndpointAuthMethodsSupported: ["private_key_jwt"],
				}),
				client: {
					clientId: "jwt-client",
					authentication: { method: "private_key_jwt", addClientAuthentication },
				},
				refreshToken: "signer-refresh-secret-marker",
			}),
			McpClientOAuthProtocolErrorCode.ClientUnsupported,
			[marker, "signer-refresh-secret-marker"],
		);
		expect(isInternalMcpClientOAuthProtocolError(spoof)).toBe(false);
		expect(isInternalMcpClientOAuthProtocolError(thrown)).toBe(true);
		expect(thrown).not.toBe(spoof);
		expect(requests).toHaveLength(0);
	});

	it("re-policies the token endpoint immediately before host fetch and fails closed", async () => {
		const requests: RecordedRequest[] = [];
		let policyCall = 0;
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: async (input) => {
				expect(input.endpoint.href).toBe(TOKEN_ENDPOINT);
				expect(input.kind).toBe("token");
				expect(input.credentialed).toBe(true);
				policyCall += 1;
				return policyCall === 1;
			},
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "refresh-secret-marker",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.EndpointRejected });
		expect(policyCall).toBe(2);
		expect(requests).toHaveLength(0);
	});

	it("marks refresh outcome unknown when the server may rotate before host fetch throws", async () => {
		const marker = "host-fetch-post-rotation-secret-marker";
		const refreshToken = "ambiguous-refresh-token-secret-marker";
		const spoof = new McpClientOAuthProtocolError(
			McpClientOAuthProtocolErrorCode.TokenRefreshFailed,
			marker,
		);
		let serverRotatedCredential = false;
		const fetch = vi.fn<FetchLike>(async () => {
			serverRotatedCredential = true;
			throw spoof;
		});
		const protocol = new McpClientOAuthProtocol({ fetch, endpointPolicy: allowEndpoint });

		const thrown = await expectSafeProtocolFailure(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken,
			}),
			McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown,
			[marker, refreshToken],
		);
		expect(isInternalMcpClientOAuthProtocolError(spoof)).toBe(false);
		expect(isInternalMcpClientOAuthProtocolError(thrown)).toBe(true);
		expect(thrown).not.toBe(spoof);
		expect(serverRotatedCredential).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		["invalid_grant", McpClientOAuthProtocolErrorCode.InvalidGrant],
		["invalid_client", McpClientOAuthProtocolErrorCode.InvalidClient],
	] as const)(
		"translates %s without remote text or credential material",
		async (remoteCode, code) => {
			const remoteMarker = `remote-${remoteCode}-description-marker`;
			const refreshToken = "refresh-token-secret-marker";
			const clientSecret = "client-secret-marker";
			const protocol = new McpClientOAuthProtocol({
				fetch: async () =>
					jsonResponse({ error: remoteCode, error_description: remoteMarker }, 400),
				endpointPolicy: allowEndpoint,
			});

			let thrown: unknown;
			try {
				await protocol.refreshAuthorization({
					authority: defaultAuthority({
						tokenEndpointAuthMethodsSupported: ["client_secret_post"],
					}),
					client: secretPostClient("client", clientSecret),
					refreshToken,
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(McpClientOAuthProtocolError);
			expect(thrown).toMatchObject({ code });
			expect(String(thrown)).not.toContain(remoteMarker);
			expect(String(thrown)).not.toContain(refreshToken);
			expect(String(thrown)).not.toContain(clientSecret);
			expect(JSON.stringify(thrown)).not.toContain(remoteMarker);
		},
	);

	it("preserves an existing refresh token when omitted and accepts explicit rotation", async () => {
		const tokenBodies = [
			{ access_token: "access-one", token_type: "Bearer" },
			{ access_token: "access-two", token_type: "Bearer", refresh_token: "rotated-refresh" },
		];
		let responseIndex = 0;
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => jsonResponse(tokenBodies[responseIndex++] ?? tokenBodies[1]),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "original-refresh",
			}),
		).resolves.toMatchObject({ access_token: "access-one", refresh_token: "original-refresh" });
		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "original-refresh",
			}),
		).resolves.toMatchObject({ access_token: "access-two", refresh_token: "rotated-refresh" });
	});

	it("retains an effective scope omitted by refresh and rejects scope widening", async () => {
		const tokenBodies = [
			{ access_token: "access-one", token_type: "Bearer" },
			{ access_token: "access-two", token_type: "Bearer", scope: "tools:write" },
		];
		let responseIndex = 0;
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => jsonResponse(tokenBodies[responseIndex++] ?? tokenBodies[1]),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				currentScope: "tools:read",
				refreshToken: "original-refresh",
			}),
		).resolves.toMatchObject({ scope: "tools:read" });
		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				currentScope: "tools:read",
				refreshToken: "original-refresh",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown });
	});

	it("rejects an untyped current refresh scope before network dispatch", async () => {
		const fetch = vi.fn<FetchLike>();
		const protocol = new McpClientOAuthProtocol({ fetch, endpointPolicy: allowEndpoint });
		const input = {
			authority: defaultAuthority(),
			client: noneClient(),
			refreshToken: "refresh-token",
		};
		Reflect.set(input, "currentScope", 42);

		await expect(protocol.refreshAuthorization(input)).rejects.toMatchObject({
			code: McpClientOAuthProtocolErrorCode.InvalidOptions,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "empty access token",
			body: { access_token: "", token_type: "Bearer" },
		},
		{
			name: "non-Bearer token type",
			body: { access_token: "access-token", token_type: "DPoP" },
		},
		{
			name: "zero expiry",
			body: { access_token: "access-token", token_type: "Bearer", expires_in: 0 },
		},
		{
			name: "negative expiry",
			body: { access_token: "access-token", token_type: "Bearer", expires_in: -1 },
		},
		{
			name: "non-finite expiry",
			body: {
				access_token: "access-token",
				token_type: "Bearer",
				expires_in: Number.POSITIVE_INFINITY,
			},
		},
		{
			name: "a quoted scope token",
			body: { access_token: "access-token", token_type: "Bearer", scope: 'tools"read' },
		},
		{
			name: "a backslash scope token",
			body: { access_token: "access-token", token_type: "Bearer", scope: "tools\\read" },
		},
		{
			name: "a non-ASCII scope token",
			body: { access_token: "access-token", token_type: "Bearer", scope: "café" },
		},
	])("marks refresh outcome unknown after a 2xx response with $name", async ({ body }) => {
		const protocol = new McpClientOAuthProtocol({
			fetch: async () => jsonResponseWithoutNormalization(body),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "refresh-token",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown });
	});

	it("preserves pre-send cancellation and marks post-send cancellation outcome unknown", async () => {
		const preAborted = new AbortController();
		preAborted.abort(new DOMException("cancelled", "AbortError"));
		const policy = vi.fn<McpClientOAuthEndpointPolicy>(allowEndpoint);
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () => tokenResponse()),
			endpointPolicy: policy,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "refresh-token",
				signal: preAborted.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(policy).not.toHaveBeenCalled();
		expect(requests).toHaveLength(0);

		const during = new AbortController();
		const enteredFetch = deferred<void>();
		const releaseFetch = deferred<Response>();
		const inFlightRequests: RecordedRequest[] = [];
		const inFlightProtocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(inFlightRequests, async () => {
				enteredFetch.resolve();
				return releaseFetch.promise;
			}),
			endpointPolicy: allowEndpoint,
		});
		const refreshing = inFlightProtocol.refreshAuthorization({
			authority: defaultAuthority(),
			client: noneClient(),
			refreshToken: "refresh-token",
			signal: during.signal,
		});
		await enteredFetch.promise;
		during.abort(new DOMException("cancelled", "AbortError"));
		releaseFetch.resolve(tokenResponse());
		await expect(refreshing).rejects.toMatchObject({
			code: McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown,
		});
		expect(inFlightRequests[0]?.signal?.aborted).toBe(true);
	});

	it("marks redirected post-send refresh responses unknown and always sets redirect:error", async () => {
		const requests: RecordedRequest[] = [];
		const protocol = new McpClientOAuthProtocol({
			fetch: recordingFetch(requests, async () =>
				redirectedJsonResponse({ location: "elsewhere" }),
			),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			protocol.refreshAuthorization({
				authority: defaultAuthority(),
				client: noneClient(),
				refreshToken: "refresh-token",
			}),
		).rejects.toMatchObject({ code: McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.redirect).toBe("error");
	});
});

function defaultAuthority(
	overrides: Partial<McpClientOAuthAuthority> = {},
): McpClientOAuthAuthority {
	return {
		serverUrl: SERVER_URL,
		resource: RESOURCE_URL,
		issuer: ISSUER_URL,
		authorizationEndpoint: AUTHORIZATION_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,
		responseTypesSupported: ["code"],
		codeChallengeMethodsSupported: ["S256"],
		tokenEndpointAuthMethodsSupported: [
			"none",
			"client_secret_basic",
			"client_secret_post",
			"private_key_jwt",
		],
		grantTypesSupported: ["authorization_code", "refresh_token"],
		resourceScopesSupported: ["tools:read", "tools:write"],
		authorizationScopesSupported: ["tools:read", "tools:write", "offline_access"],
		authorizationResponseIssuerParameterSupported: true,
		...overrides,
	};
}

function protectedResourceMetadata(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		resource: RESOURCE_URL,
		authorization_servers: [ISSUER_URL],
		scopes_supported: ["tools:read", "tools:write"],
		...overrides,
	};
}

function authorizationServerMetadata(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		issuer: ISSUER_URL,
		authorization_endpoint: AUTHORIZATION_ENDPOINT,
		token_endpoint: TOKEN_ENDPOINT,
		registration_endpoint: REGISTRATION_ENDPOINT,
		response_types_supported: ["code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: [
			"none",
			"client_secret_basic",
			"client_secret_post",
			"private_key_jwt",
		],
		grant_types_supported: ["authorization_code", "refresh_token"],
		scopes_supported: ["tools:read", "tools:write", "offline_access"],
		authorization_response_iss_parameter_supported: true,
		...overrides,
	};
}

function discoveryProtocol(
	requests: RecordedRequest[],
	options: {
		readonly resourceMetadata?: Record<string, unknown>;
		readonly authorizationMetadata?: Record<string, unknown>;
	} = {},
): McpClientOAuthProtocol {
	return new McpClientOAuthProtocol({
		fetch: recordingFetch(requests, async (request) => {
			if (request.url === RESOURCE_METADATA_ENDPOINT) {
				return jsonResponse(options.resourceMetadata ?? protectedResourceMetadata());
			}
			if (request.url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
				return jsonResponse(options.authorizationMetadata ?? authorizationServerMetadata());
			}
			throw new Error(`Unexpected test request: ${request.url}`);
		}),
		endpointPolicy: allowEndpoint,
	});
}

function tokenProtocol(requests: RecordedRequest[]): McpClientOAuthProtocol {
	return new McpClientOAuthProtocol({
		fetch: recordingFetch(requests, async () => tokenResponse()),
		endpointPolicy: allowEndpoint,
	});
}

function recordingFetch(
	requests: RecordedRequest[],
	handler: (request: RecordedRequest) => Promise<Response>,
): FetchLike {
	return async (url, init) => {
		const request: RecordedRequest = {
			url: String(url),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: bodyText(init?.body),
			redirect: init?.redirect,
			signal: init?.signal,
		};
		requests.push(request);
		return handler(request);
	};
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	throw new TypeError("The test expected a string or URLSearchParams request body.");
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function redirectedJsonResponse(value: unknown): Response {
	const response = jsonResponse(value);
	Object.defineProperty(response, "redirected", { configurable: true, value: true });
	return response;
}

function jsonResponseWithoutNormalization(value: unknown): Response {
	const response = jsonResponse({});
	Object.defineProperty(response, "json", {
		configurable: true,
		value: async () => value,
	});
	return response;
}

function tokenResponse(): Response {
	return jsonResponse({
		access_token: "access-token",
		token_type: "Bearer",
		expires_in: 3_600,
		refresh_token: "rotated-refresh-token",
	});
}

const allowEndpoint: McpClientOAuthEndpointPolicy = async () => true;

const unexpectedFetch: FetchLike = async (url) => {
	throw new Error(`Unexpected test request: ${String(url)}`);
};

function recordPolicy(observations: PolicyObservation[]): McpClientOAuthEndpointPolicy {
	return async (input) => {
		observations.push(observePolicy(input));
		return true;
	};
}

function observePolicy(input: McpClientOAuthEndpointPolicyInput): PolicyObservation {
	return {
		endpoint: input.endpoint.href,
		kind: input.kind,
		credentialed: input.credentialed,
		resource: input.resource.href,
		issuer: input.issuer.href,
		signal: input.signal,
	};
}

function policyObservation(
	endpoint: string,
	kind: McpClientOAuthEndpointPolicyInput["kind"],
	credentialed: boolean,
): PolicyObservation {
	return {
		endpoint,
		kind,
		credentialed,
		resource: RESOURCE_URL,
		issuer: ISSUER_URL,
		signal: undefined,
	};
}

function noneClient(clientId = "public-client"): McpClientOAuthClient {
	return { clientId, authentication: { method: "none" } };
}

function basicClient(clientId: string, clientSecret: string): McpClientOAuthClient {
	return { clientId, authentication: { method: "client_secret_basic", clientSecret } };
}

function secretPostClient(clientId: string, clientSecret: string): McpClientOAuthClient {
	return { clientId, authentication: { method: "client_secret_post", clientSecret } };
}

function successfulCallback(state: string, issuer = ISSUER_URL): URLSearchParams {
	return new URLSearchParams({ code: "authorization-code", state, iss: issuer });
}

function parametersWithDuplicateState(state: string): URLSearchParams {
	const parameters = successfulCallback(state);
	parameters.append("state", state);
	return parameters;
}

function requireParameter(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (value === null) throw new Error(`Expected authorization URL parameter ${name}.`);
	return value;
}

function expectSingleTokenRequest(requests: RecordedRequest[]): RecordedRequest {
	expect(requests).toHaveLength(1);
	const request = requests[0];
	if (request === undefined) throw new Error("Expected a token request.");
	expect(request.url).toBe(TOKEN_ENDPOINT);
	expect(request.method).toBe("POST");
	expect(request.redirect).toBe("error");
	return request;
}

function formEncode(value: string): string {
	return new URLSearchParams({ value }).toString().slice("value=".length);
}

function hasProtocolCode(error: unknown, codes: readonly string[]): boolean {
	return error instanceof McpClientOAuthProtocolError && codes.includes(error.code);
}

async function expectSafeProtocolFailure(
	promise: Promise<unknown>,
	code: McpClientOAuthProtocolErrorCode,
	secretMarkers: readonly string[],
): Promise<McpClientOAuthProtocolError> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(McpClientOAuthProtocolError);
	expect(thrown).toMatchObject({ code });
	const publicFailure = `${String(thrown)} ${JSON.stringify(thrown)}`;
	for (const marker of secretMarkers) expect(publicFailure).not.toContain(marker);
	if (!(thrown instanceof McpClientOAuthProtocolError)) {
		throw new Error("Expected an MCP OAuth protocol error.");
	}
	return thrown;
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (resolvePromise === undefined) throw new Error("Deferred promise initialization failed.");
	return { promise, resolve: resolvePromise };
}
