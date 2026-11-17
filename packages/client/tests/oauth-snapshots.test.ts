import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	McpClientOAuthProtocol,
	McpClientOAuthSnapshotError,
	parseMcpClientOAuthAuthority,
	parseMcpClientOAuthAuthorizationTransaction,
	parseMcpClientOAuthBootstrapDiscoveryResult,
	type McpClientOAuthAuthority,
	type McpClientOAuthBootstrapDiscoveryResult,
} from "../src/oauth/index.ts";

const authority: McpClientOAuthAuthority = {
	serverUrl: "https://mcp.example.test/mcp",
	resource: "https://mcp.example.test/mcp",
	issuer: "https://issuer.example.test",
	authorizationEndpoint: "https://issuer.example.test/authorize",
	tokenEndpoint: "https://issuer.example.test/token",
	responseTypesSupported: ["code"],
	codeChallengeMethodsSupported: ["S256"],
	tokenEndpointAuthMethodsSupported: ["none"],
	authorizationResponseIssuerParameterSupported: false,
};

describe("OAuth storage snapshots", () => {
	it("decodes an authority with exact issuer identity, detached immutable lists, and optional RFC 9207", () => {
		const input = { ...authority, responseTypesSupported: [...authority.responseTypesSupported] };
		const parsed = parseMcpClientOAuthAuthority(input);
		expectTypeOf(parsed).toEqualTypeOf<McpClientOAuthAuthority>();
		expect(parsed).toEqual(authority);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.responseTypesSupported)).toBe(true);
		input.responseTypesSupported = ["token"];
		expect(parsed.responseTypesSupported).toEqual(["code"]);
	});

	it.each([
		{ extra: "unexpected" },
		{ tokenEndpoint: "http://internal.test/token" },
		{ responseTypesSupported: ["token"] },
		{ codeChallengeMethodsSupported: ["plain"] },
		{ tokenEndpointAuthMethodsSupported: [] },
		{ resourceScopesSupported: ["bad scope"] },
		{ authorizationResponseIssuerParameterSupported: undefined },
	])(
		"rejects invalid authority shape or protocol semantics without payload-bearing errors: %j",
		(change) => {
			expect(() => parseMcpClientOAuthAuthority({ ...authority, ...change })).toThrow(
				McpClientOAuthSnapshotError,
			);
		},
	);

	it("rejects accessors and proxies before executing their code", () => {
		const getter = vi.fn(() => "secret-sentinel");
		const input = { ...authority };
		Object.defineProperty(input, "tokenEndpoint", { enumerable: true, get: getter });
		expect(() => parseMcpClientOAuthAuthority(input)).toThrow(
			"The MCP OAuth snapshot is invalid or exceeds its bounds.",
		);
		expect(getter).not.toHaveBeenCalled();
		const trap = vi.fn();
		expect(() => parseMcpClientOAuthAuthority(new Proxy(authority, { ownKeys: trap }))).toThrow(
			McpClientOAuthSnapshotError,
		);
		expect(trap).not.toHaveBeenCalled();
	});

	it("enforces caller bounds inside hard ceilings", () => {
		expect(() => parseMcpClientOAuthAuthority(authority, { maxBytes: 10 })).toThrow(
			McpClientOAuthSnapshotError,
		);
		expect(() => parseMcpClientOAuthAuthority(authority, { maxUrlLength: 10 })).toThrow(
			McpClientOAuthSnapshotError,
		);
		expect(() => parseMcpClientOAuthAuthority(authority, { maxUrlLength: 4_097 })).toThrow(
			McpClientOAuthSnapshotError,
		);
		expect(() =>
			parseMcpClientOAuthAuthority(authority, { maxBytes: Number.POSITIVE_INFINITY }),
		).toThrow(McpClientOAuthSnapshotError);
	});

	it.each(["https://app.example.test/callback", "http://127.0.0.1:8765/callback"])(
		"round-trips a real secret-bearing authorization transaction for %s",
		async (redirectUri) => {
			const fetch = vi.fn(async () => {
				throw new Error("No network I/O allowed");
			});
			const protocol = new McpClientOAuthProtocol({
				fetch,
				endpointPolicy: () => true,
				now: () => 1_000,
			});
			const { transaction } = await protocol.startAuthorization({
				authority,
				client: { clientId: "example-client", authentication: { method: "none" } },
				redirectUri,
			});
			const encoded: unknown = JSON.parse(JSON.stringify(transaction));
			expect(parseMcpClientOAuthAuthorizationTransaction(encoded)).toEqual(transaction);
			expect(fetch).not.toHaveBeenCalled();
			for (const change of [
				{ authority: { ...authority, issuer: "https://other.example.test" } },
				{ stateDigest: "invalid" },
				{ authorityDigest: "a".repeat(43) },
				{ codeVerifier: "secret-sentinel" },
				{ createdAtMs: -1 },
				{ redirectUri: "http://untrusted.example.test/callback" },
				{ scope: "bad\\scope" },
			]) {
				try {
					parseMcpClientOAuthAuthorizationTransaction({ ...transaction, ...change });
					throw new Error("Expected invalid snapshot");
				} catch (error) {
					expect(error).toMatchObject({ code: "MCP_CLIENT_OAUTH_SNAPSHOT_INVALID" });
					expect(String(error)).not.toContain("secret-sentinel");
					expect(error).not.toHaveProperty("cause");
				}
			}
		},
	);

	it("decodes all discovery variants and rejects mismatched nested authority or unknown fields", () => {
		const resource = {
			serverUrl: authority.serverUrl,
			resource: authority.resource,
			resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
		};
		const ready = {
			kind: "ready",
			resource,
			candidate: {
				authority,
				clientIdMetadataDocumentSupported: true,
				legacyDynamicRegistrationEndpoint: "https://issuer.example.test/register",
			},
		} as const;
		const variants = [
			ready,
			{
				kind: "authorization-server-selection-required",
				resource,
				candidates: [{ issuer: authority.issuer }, { issuer: "https://other.example.test" }],
			},
			{
				kind: "strict-protocol-unsupported",
				resource,
				issuer: authority.issuer,
				issues: ["pkce_s256_unsupported"],
			},
		];
		for (const value of variants) {
			const result = parseMcpClientOAuthBootstrapDiscoveryResult(value);
			expectTypeOf(result).toEqualTypeOf<McpClientOAuthBootstrapDiscoveryResult>();
			expect(result).toEqual(value);
			expect(Object.isFrozen(result.resource)).toBe(true);
		}
		expect(() =>
			parseMcpClientOAuthBootstrapDiscoveryResult({
				...ready,
				candidate: { ...ready.candidate, secret: "sentinel" },
			}),
		).toThrow(McpClientOAuthSnapshotError);
		expect(() =>
			parseMcpClientOAuthBootstrapDiscoveryResult({
				...ready,
				resource: { ...resource, resource: "https://other.example.test/" },
			}),
		).toThrow(McpClientOAuthSnapshotError);
		expect(() =>
			parseMcpClientOAuthBootstrapDiscoveryResult({
				...variants[1],
				candidates: [{ issuer: authority.issuer }, { issuer: authority.issuer }],
			}),
		).toThrow(McpClientOAuthSnapshotError);
	});
});
