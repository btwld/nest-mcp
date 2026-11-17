import { describe, expect, it } from "vitest";
import {
	getMcpClientOAuthApplicationType,
	mcpClientOAuthScopesCover,
	planMcpClientOAuthProvisioning,
	type McpClientOAuthExistingClient,
	type McpClientOAuthProvisioningInput,
} from "../src/oauth/provisioning.ts";
import type { McpClientOAuthBootstrapReady } from "../src/oauth/bootstrap.ts";

const callback = "https://console.example.test/oauth/callback";
const metadata = "https://console.example.test/oauth/client";
const ready: McpClientOAuthBootstrapReady = {
	kind: "ready",
	scopes: ["calendar.read"],
	resource: {
		serverUrl: "https://tools.example.test/mcp",
		resource: "https://tools.example.test/mcp",
		resourceMetadataUrl: "https://tools.example.test/.well-known/oauth-protected-resource/mcp",
	},
	candidate: {
		clientIdMetadataDocumentSupported: true,
		legacyDynamicRegistrationEndpoint: "https://identity.example.test/register",
		authority: {
			serverUrl: "https://tools.example.test/mcp",
			resource: "https://tools.example.test/mcp",
			issuer: "https://identity.example.test",
			authorizationEndpoint: "https://identity.example.test/authorize",
			tokenEndpoint: "https://identity.example.test/token",
			responseTypesSupported: ["code"],
			codeChallengeMethodsSupported: ["S256"],
			tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic", "private_key_jwt"],
			authorizationResponseIssuerParameterSupported: false,
		},
	},
};
const manual: McpClientOAuthExistingClient = {
	clientId: "desktop-calendar",
	serverUrl: ready.resource.serverUrl,
	resource: ready.resource.resource,
	issuer: ready.candidate.authority.issuer,
	provisioningMethod: "manual",
	authenticationMethod: "none",
	authenticationAvailable: false,
	scopes: ["calendar.read", "calendar.write"],
};
const automatic: McpClientOAuthExistingClient = {
	...manual,
	provisioningMethod: "dynamic_registration",
	redirectUri: callback,
};
function plan(overrides: Partial<McpClientOAuthProvisioningInput> = {}) {
	return planMcpClientOAuthProvisioning({
		discovery: ready,
		redirectUri: callback,
		clientIdMetadataUrl: metadata,
		strategies: ["reuse", "client_id_metadata", "dynamic_registration"],
		...overrides,
	});
}

describe("OAuth provisioning decisions for an independent calendar host", () => {
	it("retains a manual client's configured scopes and supports host-owned signing credentials", () => {
		expect(
			plan({
				existingClient: {
					...manual,
					authenticationMethod: "private_key_jwt",
					authenticationAvailable: true,
				},
			}),
		).toEqual({
			kind: "reuse",
			existingClientStatus: "reusable",
			authorizationScopes: ["calendar.read", "calendar.write"],
		});
		expect(
			plan({ existingClient: { ...manual, authenticationMethod: "private_key_jwt" } })
				.existingClientStatus,
		).toBe("incompatible");
	});
	it("preserves registered allowance while requesting only the fresh subset", () => {
		const result = plan({ existingClient: automatic });
		expect(result).toEqual({
			kind: "reuse",
			existingClientStatus: "reusable",
			authorizationScopes: ["calendar.read"],
		});
		expect(automatic.scopes).toEqual(["calendar.read", "calendar.write"]);
		expect(Object.isFrozen(result.authorizationScopes)).toBe(true);
		const { scopes: _scopes, ...noScopes } = ready;
		expect(plan({ discovery: noScopes, existingClient: automatic }).authorizationScopes).toEqual(
			[],
		);
	});
	it("does not repeat a registration to expand its scope without an explicit host policy", () => {
		const existingClient = { ...automatic, scopes: ["calendar.write"] };
		expect(plan({ existingClient, strategies: ["reuse", "dynamic_registration"] }).kind).toBe(
			"registration_scope_insufficient",
		);
		expect(
			plan({
				existingClient,
				strategies: ["reuse", "dynamic_registration"],
				allowRegistrationAfterScopeExpansion: true,
			}).kind,
		).toBe("dynamic_registration");
		expect(plan({ existingClient }).kind).toBe("client_id_metadata");
	});
	it("uses host order and never selects an omitted strategy", () => {
		expect(plan({ existingClient: manual, strategies: ["client_id_metadata", "reuse"] }).kind).toBe(
			"client_id_metadata",
		);
		expect(plan({ strategies: [] }).kind).toBe("manual_client_required");
		expect(plan({ strategies: ["dynamic_registration"] }).kind).toBe("dynamic_registration");
	});
	it.each([
		{ issuer: "https://other.example.test" },
		{ resource: "https://tools.example.test/other" },
		{ serverUrl: "https://tools.example.test/other" },
		{ redirectUri: "https://other.example.test/callback" },
		{ authenticationMethod: "client_secret_post" as const, authenticationAvailable: true },
	])("rejects reuse when the immutable binding changes: %j", (change) => {
		expect(plan({ existingClient: { ...automatic, ...change } }).existingClientStatus).toBe(
			"incompatible",
		);
	});
	it("requires the current CIMD identity and capability to reuse an automatic metadata client", () => {
		const existingClient = {
			...automatic,
			clientId: metadata,
			provisioningMethod: "client_id_metadata" as const,
		};
		expect(plan({ existingClient }).kind).toBe("reuse");
		expect(
			plan({ existingClient, clientIdMetadataUrl: `${metadata}-new` }).existingClientStatus,
		).toBe("incompatible");
		expect(
			plan({
				existingClient,
				discovery: {
					...ready,
					candidate: { ...ready.candidate, clientIdMetadataDocumentSupported: false },
				},
			}).kind,
		).toBe("dynamic_registration");
	});
	it("does not select public provisioning when the provider requires a confidential client", () => {
		const discovery = {
			...ready,
			candidate: {
				...ready.candidate,
				authority: {
					...ready.candidate.authority,
					tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
				},
			},
		};
		expect(plan({ discovery }).kind).toBe("manual_client_required");
	});
	it("selects native registration for an admitted loopback callback", () => {
		expect(plan({ redirectUri: "http://127.0.0.1:8080/callback" }).kind).toBe(
			"dynamic_registration",
		);
	});
	it.each([
		"http://remote.example.test/callback",
		"https://user:secret@example.test/callback",
		"https://example.test/callback#fragment",
		"https://EXAMPLE.test/callback",
	])("rejects an invalid or noncanonical callback: %s", (redirectUri) => {
		expect(() => plan({ redirectUri })).toThrow("The MCP OAuth provisioning options are invalid.");
	});
	it("rejects duplicate strategies and hostile public provenance without invoking accessors", () => {
		expect(() => plan({ strategies: ["reuse", "reuse"] })).toThrow();
		const existingClient = { ...manual };
		Object.defineProperty(existingClient, "clientId", {
			enumerable: true,
			get() {
				throw new Error("secret-sentinel");
			},
		});
		expect(() => plan({ existingClient })).toThrow(
			"The MCP OAuth snapshot is invalid or exceeds its bounds.",
		);
	});
	it("checks bounded RFC scope sets, preserving punctuation and empty requests", () => {
		expect(mcpClientOAuthScopesCover(["read,write"], ["read,write"])).toBe(true);
		expect(mcpClientOAuthScopesCover([], [])).toBe(true);
		expect(mcpClientOAuthScopesCover([], ["read"])).toBe(false);
		expect(() => mcpClientOAuthScopesCover(["bad scope"])).toThrow();
	});
	it.each([
		"http://localhost:8080/callback",
		"http://[::1]:8080/callback",
		"http://127.10.20.30/callback",
	])("classifies loopback callbacks without network I/O: %s", (value) => {
		expect(getMcpClientOAuthApplicationType(value)).toBe("native");
	});
});
