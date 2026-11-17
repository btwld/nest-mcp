import type { FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
	McpClientOAuthBootstrap,
	McpClientOAuthBootstrapErrorCode,
	McpClientOAuthStrictCompatibilityIssue,
	parseMcpClientOAuthBootstrapChallenge,
	type McpClientOAuthBootstrapEndpointPolicyInput,
} from "../src/oauth/bootstrap.ts";
import { McpClientOAuthProtocol } from "../src/oauth/protocol.ts";

const SERVER_URL = "https://mcp.example.test/api/mcp";
const RESOURCE_URL = "https://mcp.example.test/api/mcp";
const RESOURCE_METADATA_ENDPOINT =
	"https://mcp.example.test/.well-known/oauth-protected-resource/api/mcp";
const ROOT_RESOURCE_METADATA_ENDPOINT =
	"https://mcp.example.test/.well-known/oauth-protected-resource";
const CHALLENGE_RESOURCE_METADATA_ENDPOINT = "https://metadata.example.test/oauth/resource/api-mcp";
const ISSUER_URL = "https://issuer.example.test/tenant";
const OTHER_ISSUER_URL = "https://other-issuer.example.test/tenant";
const AUTHORIZATION_SERVER_METADATA_ENDPOINT =
	"https://issuer.example.test/.well-known/oauth-authorization-server/tenant";
const OTHER_AUTHORIZATION_SERVER_METADATA_ENDPOINT =
	"https://other-issuer.example.test/.well-known/oauth-authorization-server/tenant";
const AUTHORIZATION_ENDPOINT = "https://login.example.test/oauth/authorize";
const TOKEN_ENDPOINT = "https://login.example.test/oauth/token";
const REGISTRATION_ENDPOINT = "https://login.example.test/oauth/register";

interface RecordedRequest {
	readonly url: string;
	readonly redirect: RequestRedirect | undefined;
}

interface PolicyObservation {
	readonly endpoint: string;
	readonly kind: McpClientOAuthBootstrapEndpointPolicyInput["kind"];
	readonly credentialed: boolean;
	readonly serverUrl: string;
	readonly resource: string | undefined;
	readonly exactResource: string | undefined;
	readonly issuer: string | undefined;
	readonly exactIssuer: string | undefined;
}

describe("McpClientOAuthBootstrap", () => {
	it("uses challenge discovery and scope ahead of protected-resource scopes", async () => {
		const requests: RecordedRequest[] = [];
		const policyCalls: PolicyObservation[] = [];
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch(requests, async (url) => {
				if (url === CHALLENGE_RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(
						protectedResourceMetadata({ scopes_supported: ["resource:read", "tools:call"] }),
					);
				}
				if (url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(authorizationServerMetadata());
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
			endpointPolicy: recordPolicy(policyCalls),
		});

		const result = await bootstrap.discover({
			serverUrl: SERVER_URL,
			wwwAuthenticate:
				`Basic realm="legacy", Bearer error="invalid_token", ` +
				`resource_metadata="${CHALLENGE_RESOURCE_METADATA_ENDPOINT}", ` +
				'scope="tools:call resource:write tools:call"',
		});

		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") throw new Error("Expected ready discovery.");
		expect(result.scopes).toEqual(["tools:call", "resource:write"]);
		expect(result.resource).toEqual({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT,
			scopesSupported: ["resource:read", "tools:call"],
		});
		expect(result.candidate.authority).toMatchObject({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
			issuer: ISSUER_URL,
			authorizationEndpoint: AUTHORIZATION_ENDPOINT,
			tokenEndpoint: TOKEN_ENDPOINT,
		});
		expect(result.candidate.clientIdMetadataDocumentSupported).toBe(true);
		expect(result.candidate.legacyDynamicRegistrationEndpoint).toBe(REGISTRATION_ENDPOINT);
		expect(requests).toEqual([
			{ url: CHALLENGE_RESOURCE_METADATA_ENDPOINT, redirect: "error" },
			{ url: AUTHORIZATION_SERVER_METADATA_ENDPOINT, redirect: "error" },
		]);
		expect(policyCalls).toEqual([
			policyObservation(CHALLENGE_RESOURCE_METADATA_ENDPOINT, "resource-metadata", false),
			policyObservation(
				AUTHORIZATION_SERVER_METADATA_ENDPOINT,
				"authorization-server-metadata",
				false,
				RESOURCE_URL,
				ISSUER_URL,
			),
			policyObservation(AUTHORIZATION_ENDPOINT, "authorization", false, RESOURCE_URL, ISSUER_URL),
			policyObservation(TOKEN_ENDPOINT, "token", true, RESOURCE_URL, ISSUER_URL),
		]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.candidate.authority)).toBe(true);
		expect(Object.isFrozen(result.scopes)).toBe(true);

		const strict = new McpClientOAuthProtocol({
			fetch: unexpectedFetch,
			endpointPolicy: allowEndpoint,
		});
		await expect(
			strict.startAuthorization({
				authority: result.candidate.authority,
				client: { clientId: "platform-client", authentication: { method: "none" } },
				redirectUri: "https://platform.example.test/oauth/callback",
				...(result.scopes === undefined ? {} : { scopes: result.scopes }),
			}),
		).resolves.toMatchObject({ authorizationUrl: expect.stringContaining("scope=") });
	});

	it("falls back through RFC 9728 well-known locations and selects resource scopes", async () => {
		const requests: RecordedRequest[] = [];
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch(requests, async (url) => {
				if (url === RESOURCE_METADATA_ENDPOINT) return jsonResponse({}, 404);
				if (url === ROOT_RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(
						protectedResourceMetadata({
							resource: "https://mcp.example.test/",
							scopes_supported: ["tools:read"],
						}),
					);
				}
				if (url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(authorizationServerMetadata());
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
			endpointPolicy: allowEndpoint,
		});

		const result = await bootstrap.discover({ serverUrl: SERVER_URL });

		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") throw new Error("Expected ready discovery.");
		expect(result.resource.resourceMetadataUrl).toBe(ROOT_RESOURCE_METADATA_ENDPOINT);
		expect(result.resource.resource).toBe("https://mcp.example.test/");
		expect(result.scopes).toEqual(["tools:read"]);
		expect(requests.map((request) => request.url)).toEqual([
			RESOURCE_METADATA_ENDPOINT,
			ROOT_RESOURCE_METADATA_ENDPOINT,
			AUTHORIZATION_SERVER_METADATA_ENDPOINT,
		]);
	});

	it("returns issuer selection instead of choosing the first advertised server", async () => {
		const requests: RecordedRequest[] = [];
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch(requests, async (url) => {
				if (url !== RESOURCE_METADATA_ENDPOINT) throw new Error(`Unexpected request: ${url}`);
				return jsonResponse(
					protectedResourceMetadata({
						authorization_servers: [ISSUER_URL, OTHER_ISSUER_URL, ISSUER_URL],
					}),
				);
			}),
			endpointPolicy: allowEndpoint,
		});

		const result = await bootstrap.discover({ serverUrl: SERVER_URL });

		expect(result).toMatchObject({
			kind: "authorization-server-selection-required",
			candidates: [{ issuer: ISSUER_URL }, { issuer: OTHER_ISSUER_URL }],
		});
		expect(requests.map((request) => request.url)).toEqual([RESOURCE_METADATA_ENDPOINT]);
	});

	it("discovers only the exact host-selected issuer", async () => {
		const requests: RecordedRequest[] = [];
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch(requests, async (url) => {
				if (url === RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(
						protectedResourceMetadata({
							authorization_servers: [ISSUER_URL, OTHER_ISSUER_URL],
						}),
					);
				}
				if (url === OTHER_AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(
						authorizationServerMetadata({
							issuer: OTHER_ISSUER_URL,
							authorization_endpoint: "https://other-login.example.test/authorize",
							token_endpoint: "https://other-login.example.test/token",
						}),
					);
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
			endpointPolicy: allowEndpoint,
		});

		const result = await bootstrap.discover({
			serverUrl: SERVER_URL,
			issuer: OTHER_ISSUER_URL,
		});

		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") throw new Error("Expected ready discovery.");
		expect(result.candidate.authority.issuer).toBe(OTHER_ISSUER_URL);
		expect(requests.map((request) => request.url)).toEqual([
			RESOURCE_METADATA_ENDPOINT,
			OTHER_AUTHORIZATION_SERVER_METADATA_ENDPOINT,
		]);
	});

	it("returns explicit strict-compatibility issues without exposing remote endpoints", async () => {
		const bootstrap = discoveryBootstrap(
			authorizationServerMetadata({
				code_challenge_methods_supported: undefined,
				token_endpoint_auth_methods_supported: undefined,
			}),
		);

		const result = await bootstrap.discover({ serverUrl: SERVER_URL });

		expect(result).toEqual({
			kind: "strict-protocol-unsupported",
			resource: {
				serverUrl: SERVER_URL,
				resource: RESOURCE_URL,
				resourceMetadataUrl: RESOURCE_METADATA_ENDPOINT,
			},
			issuer: ISSUER_URL,
			issues: [
				McpClientOAuthStrictCompatibilityIssue.PkceS256Unsupported,
				McpClientOAuthStrictCompatibilityIssue.TokenEndpointAuthenticationUnsupported,
			],
		});
		expect(JSON.stringify(result)).not.toContain(AUTHORIZATION_ENDPOINT);
		expect(JSON.stringify(result)).not.toContain(TOKEN_ENDPOINT);
	});

	it.each([
		{ name: "omitted", supported: undefined },
		{ name: "false", supported: false },
	] as const)(
		"accepts an authorization server with $name RFC 9207 response-issuer support",
		async ({ supported }) => {
			const bootstrap = discoveryBootstrap(
				authorizationServerMetadata({
					authorization_response_iss_parameter_supported: supported,
				}),
			);

			const result = await bootstrap.discover({ serverUrl: SERVER_URL });

			expect(result.kind).toBe("ready");
			if (result.kind !== "ready") throw new Error("Expected ready discovery.");
			expect(result.candidate.authority.authorizationResponseIssuerParameterSupported).toBe(false);
		},
	);

	it("returns an authority accepted directly by the strict authorization starter", async () => {
		const bootstrap = discoveryBootstrap(authorizationServerMetadata());
		const result = await bootstrap.discover({ serverUrl: SERVER_URL });
		if (result.kind !== "ready") throw new Error("Expected ready discovery.");
		const strict = new McpClientOAuthProtocol({
			fetch: unexpectedFetch,
			endpointPolicy: allowEndpoint,
		});

		const started = await strict.startAuthorization({
			authority: result.candidate.authority,
			client: { clientId: "platform-client", authentication: { method: "none" } },
			redirectUri: "https://platform.example.test/oauth/callback",
			...(result.scopes === undefined ? {} : { scopes: result.scopes }),
		});

		expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("platform-client");
	});

	it("rejects a selected issuer that was not advertised before fetching it", async () => {
		const requests: RecordedRequest[] = [];
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch(requests, async () => jsonResponse(protectedResourceMetadata())),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			bootstrap.discover({ serverUrl: SERVER_URL, issuer: OTHER_ISSUER_URL }),
		).rejects.toMatchObject({ code: McpClientOAuthBootstrapErrorCode.AuthorityInvalid });
		expect(requests.map((request) => request.url)).toEqual([RESOURCE_METADATA_ENDPOINT]);
	});

	it("preserves issuer strings and rejects a trailing-slash metadata mismatch", async () => {
		const advertisedIssuer = `${ISSUER_URL}/`;
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async (url) => {
				if (url === RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(
						protectedResourceMetadata({ authorization_servers: [advertisedIssuer] }),
					);
				}
				if (url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(authorizationServerMetadata({ issuer: ISSUER_URL }));
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
			endpointPolicy: allowEndpoint,
		});

		await expect(bootstrap.discover({ serverUrl: SERVER_URL })).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.AuthorityInvalid,
		});
	});

	it("fails closed when endpoint policy does not return literal true", async () => {
		const fetch = vi.fn<FetchLike>();
		const bootstrap = new McpClientOAuthBootstrap({
			fetch,
			// Untyped host behavior is intentionally covered at runtime.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			endpointPolicy: () => "true" as never,
		});

		await expect(bootstrap.discover({ serverUrl: SERVER_URL })).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.EndpointRejected,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds raw Bearer challenge parsing and drops remote error text", () => {
		expect(
			parseMcpClientOAuthBootstrapChallenge(
				`Bearer error_description="secret marker", ` +
					`resource_metadata="${CHALLENGE_RESOURCE_METADATA_ENDPOINT}", scope="tools:read"`,
			),
		).toEqual({
			resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT,
			scope: "tools:read",
		});
		expect(
			JSON.stringify(
				parseMcpClientOAuthBootstrapChallenge(
					'Bearer error_description="secret marker", scope="tools:read"',
				),
			),
		).not.toContain("secret marker");
		expect(() => parseMcpClientOAuthBootstrapChallenge(`Bearer ${"x".repeat(8_193)}`)).toThrow(
			expect.objectContaining({ code: McpClientOAuthBootstrapErrorCode.InvalidOptions }),
		);
	});

	it("does not attribute parameters from a later authentication challenge to Bearer", () => {
		expect(parseMcpClientOAuthBootstrapChallenge('Bearer realm="mcp", Basic scope="evil"')).toEqual(
			{},
		);
		expect(
			parseMcpClientOAuthBootstrapChallenge(
				'Bearer scope="tools:read", Basic resource_metadata="https://evil.example/mcp"',
			),
		).toEqual({ scope: "tools:read" });
	});

	it("does not extract parameter-looking text from quoted Bearer values", () => {
		expect(
			parseMcpClientOAuthBootstrapChallenge(
				'Bearer error_description="see resource_metadata=https://evil.example/meta now", scope="tools:read"',
			),
		).toEqual({ scope: "tools:read" });
		expect(
			parseMcpClientOAuthBootstrapChallenge('Bearer realm="scope=evil", scope="tools:read"'),
		).toEqual({ scope: "tools:read" });
	});

	it("accepts HTAB only as authentication grammar whitespace", () => {
		expect(
			parseMcpClientOAuthBootstrapChallenge(
				`Bearer\trealm="mcp",\tresource_metadata\t=\t"${CHALLENGE_RESOURCE_METADATA_ENDPOINT}",\tscope\t=\t"tools:read"`,
			),
		).toEqual({
			resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT,
			scope: "tools:read",
		});
		expect(() => parseMcpClientOAuthBootstrapChallenge('Bearer scope="tools:\tread"')).toThrow(
			expect.objectContaining({ code: McpClientOAuthBootstrapErrorCode.InvalidOptions }),
		);
	});

	it("rejects protected-resource metadata outside the requested resource", async () => {
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async () =>
				jsonResponse(protectedResourceMetadata({ resource: "https://other.example.test/mcp" })),
			),
			endpointPolicy: allowEndpoint,
		});

		await expect(bootstrap.discover({ serverUrl: SERVER_URL })).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid,
		});
	});

	it.each([
		{
			name: "query",
			serverUrl: `${SERVER_URL}?tenant=one`,
			resource: `${RESOURCE_URL}?tenant=two`,
		},
		{
			name: "parent path",
			serverUrl: `${SERVER_URL}/tenant/one`,
			resource: RESOURCE_URL,
		},
	])("rejects a protected resource with a substituted $name", async ({ serverUrl, resource }) => {
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async () => jsonResponse(protectedResourceMetadata({ resource }))),
			endpointPolicy: allowEndpoint,
		});

		await expect(bootstrap.discover({ serverUrl })).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid,
		});
	});

	it("binds challenge metadata to the exact requested MCP resource", async () => {
		const serverUrl = `${SERVER_URL}?tenant=one`;
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async () =>
				jsonResponse(protectedResourceMetadata({ resource: `${RESOURCE_URL}?tenant=two` })),
			),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			bootstrap.discover({
				serverUrl,
				challenge: { resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT },
			}),
		).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid,
		});
	});

	it("rejects a non-canonical protected-resource spelling before identity comparison", async () => {
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async () =>
				jsonResponse(
					protectedResourceMetadata({ resource: "https://mcp.example.test:443/api/mcp" }),
				),
			),
			endpointPolicy: allowEndpoint,
		});

		await expect(
			bootstrap.discover({
				serverUrl: SERVER_URL,
				challenge: { resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT },
			}),
		).rejects.toMatchObject({
			code: McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid,
		});
	});

	it("accepts canonical metadata when the host MCP URL normalizes a default port", async () => {
		const bootstrap = new McpClientOAuthBootstrap({
			fetch: recordingFetch([], async (url) => {
				if (url === CHALLENGE_RESOURCE_METADATA_ENDPOINT) {
					return jsonResponse(protectedResourceMetadata());
				}
				if (url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) {
					return jsonResponse(authorizationServerMetadata());
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
			endpointPolicy: allowEndpoint,
		});

		const result = await bootstrap.discover({
			serverUrl: "https://mcp.example.test:443/api/mcp",
			challenge: { resourceMetadataUrl: CHALLENGE_RESOURCE_METADATA_ENDPOINT },
		});

		expect(result.kind).toBe("ready");
		expect(result.resource).toMatchObject({
			serverUrl: SERVER_URL,
			resource: RESOURCE_URL,
		});
	});

	it("does not report ready for a client_secret_jwt-only authority", async () => {
		const bootstrap = discoveryBootstrap(
			authorizationServerMetadata({
				token_endpoint_auth_methods_supported: ["client_secret_jwt"],
			}),
		);

		await expect(bootstrap.discover({ serverUrl: SERVER_URL })).resolves.toMatchObject({
			kind: "strict-protocol-unsupported",
			issues: [McpClientOAuthStrictCompatibilityIssue.TokenEndpointAuthenticationUnsupported],
		});
	});
});

function discoveryBootstrap(metadata: Record<string, unknown>): McpClientOAuthBootstrap {
	return new McpClientOAuthBootstrap({
		fetch: recordingFetch([], async (url) => {
			if (url === RESOURCE_METADATA_ENDPOINT) return jsonResponse(protectedResourceMetadata());
			if (url === AUTHORIZATION_SERVER_METADATA_ENDPOINT) return jsonResponse(metadata);
			throw new Error(`Unexpected request: ${url}`);
		}),
		endpointPolicy: allowEndpoint,
	});
}

function protectedResourceMetadata(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		resource: RESOURCE_URL,
		authorization_servers: [ISSUER_URL],
		bearer_methods_supported: ["header"],
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
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
		...overrides,
	};
}

function recordingFetch(
	requests: RecordedRequest[],
	handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): FetchLike {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push({ url, redirect: init?.redirect });
		return handler(url, init);
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function recordPolicy(
	observations: PolicyObservation[],
): (input: McpClientOAuthBootstrapEndpointPolicyInput) => true {
	return (input) => {
		observations.push({
			endpoint: input.endpoint.href,
			kind: input.kind,
			credentialed: input.credentialed,
			serverUrl: input.serverUrl.href,
			resource: input.resource?.href,
			exactResource: input.exactResource,
			issuer: input.issuer?.href,
			exactIssuer: input.exactIssuer,
		});
		input.endpoint.hostname = "mutated.invalid";
		input.serverUrl.hostname = "mutated.invalid";
		if (input.resource !== undefined) input.resource.hostname = "mutated.invalid";
		if (input.issuer !== undefined) input.issuer.hostname = "mutated.invalid";
		return true;
	};
}

function policyObservation(
	endpoint: string,
	kind: McpClientOAuthBootstrapEndpointPolicyInput["kind"],
	credentialed: boolean,
	resource?: string,
	issuer?: string,
): PolicyObservation {
	return {
		endpoint,
		kind,
		credentialed,
		serverUrl: SERVER_URL,
		resource,
		exactResource: resource,
		issuer,
		exactIssuer: issuer,
	};
}

function allowEndpoint(): true {
	return true;
}

async function unexpectedFetch(): Promise<Response> {
	throw new Error("Unexpected fetch.");
}
