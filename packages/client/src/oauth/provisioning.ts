import {
	parseMcpClientOAuthBootstrapDiscoveryResult,
	type McpClientOAuthBootstrapReady,
} from "./bootstrap.ts";
import type { McpClientOAuthClientAuthentication } from "./protocol.ts";
import { isMcpClientOAuthScopeToken } from "./scope.ts";
import {
	assertOAuthSnapshotKeys,
	oauthSnapshotBoolean,
	oauthSnapshotString,
	oauthSnapshotStrings,
	parseOAuthSnapshot,
} from "./snapshot-data.ts";

/** Public provenance only. Credentials and the identity of the host's record stay with the host. */
export interface McpClientOAuthExistingClient {
	readonly clientId: string;
	readonly serverUrl: string;
	readonly issuer: string;
	readonly resource: string;
	readonly provisioningMethod: "manual" | "client_id_metadata" | "dynamic_registration";
	readonly authenticationMethod: McpClientOAuthClientAuthentication["method"];
	/** Whether the host can supply the secret or signing key required by this method. */
	readonly authenticationAvailable: boolean;
	/** Required for automatic-client reuse; manual clients retain host-managed redirect policy. */
	readonly redirectUri?: string;
	/** Configured manual scopes or the original registered allowance, not a previous access token grant. */
	readonly scopes: readonly string[];
}

export type McpClientOAuthProvisioningStrategy =
	"reuse" | "client_id_metadata" | "dynamic_registration";
export type McpClientOAuthExistingClientStatus =
	"absent" | "incompatible" | "scope_insufficient" | "reusable";

export interface McpClientOAuthProvisioningInput {
	readonly discovery: McpClientOAuthBootstrapReady;
	readonly redirectUri: string;
	readonly clientIdMetadataUrl?: string;
	readonly existingClient?: McpClientOAuthExistingClient;
	/** Explicit host preference order. Omitting a strategy prohibits selecting it. */
	readonly strategies: readonly McpClientOAuthProvisioningStrategy[];
	/** Defaults to false: an insufficient existing registration cannot silently cause another one. */
	readonly allowRegistrationAfterScopeExpansion?: boolean;
}

export interface McpClientOAuthProvisioningPlan {
	readonly kind:
		| "reuse"
		| "client_id_metadata"
		| "dynamic_registration"
		| "registration_scope_insufficient"
		| "manual_client_required";
	readonly existingClientStatus: McpClientOAuthExistingClientStatus;
	/** Exact scopes to request. Empty means request no scopes, including after narrower rediscovery. */
	readonly authorizationScopes: readonly string[];
}

/**
 * Pure provisioning decision over captured protocol facts and explicit host preferences.
 * Performs no I/O, registration, decryption, authorization or persistence. A registration plan
 * is only a capability result; hosts must obtain consent and fence dispatch independently.
 */
export function planMcpClientOAuthProvisioning(
	input: McpClientOAuthProvisioningInput,
): McpClientOAuthProvisioningPlan {
	const discovery = parseMcpClientOAuthBootstrapDiscoveryResult(input.discovery);
	if (discovery.kind !== "ready") throw invalidOptions();
	const applicationType = getMcpClientOAuthApplicationType(input.redirectUri);
	if (applicationType === undefined) throw invalidOptions();
	const strategies = [...input.strategies];
	if (
		strategies.length > 3 ||
		new Set(strategies).size !== strategies.length ||
		strategies.some(
			(value) =>
				value !== "reuse" && value !== "client_id_metadata" && value !== "dynamic_registration",
		) ||
		(input.allowRegistrationAfterScopeExpansion !== undefined &&
			typeof input.allowRegistrationAfterScopeExpansion !== "boolean")
	)
		throw invalidOptions();
	const clientIdMetadataUrl = input.clientIdMetadataUrl;
	if (
		clientIdMetadataUrl !== undefined &&
		getMcpClientOAuthApplicationType(clientIdMetadataUrl) !== "web"
	)
		throw invalidOptions();
	const existing =
		input.existingClient === undefined ? undefined : captureExistingClient(input.existingClient);
	const status = existingClientStatus(existing, discovery, input.redirectUri, clientIdMetadataUrl);
	const scopes = Object.freeze([...(discovery.scopes ?? [])]);
	const result = (
		kind: McpClientOAuthProvisioningPlan["kind"],
		authorizationScopes = scopes,
	): McpClientOAuthProvisioningPlan =>
		Object.freeze({ kind, existingClientStatus: status, authorizationScopes });
	const publicClient =
		discovery.candidate.authority.tokenEndpointAuthMethodsSupported.includes("none");
	for (const strategy of strategies) {
		if (strategy === "reuse" && status === "reusable" && existing !== undefined) {
			return result("reuse", existing.provisioningMethod === "manual" ? existing.scopes : scopes);
		}
		if (
			strategy === "client_id_metadata" &&
			publicClient &&
			applicationType === "web" &&
			discovery.candidate.clientIdMetadataDocumentSupported &&
			clientIdMetadataUrl !== undefined
		)
			return result("client_id_metadata");
		if (
			strategy === "dynamic_registration" &&
			publicClient &&
			discovery.candidate.legacyDynamicRegistrationEndpoint !== undefined
		) {
			if (status === "scope_insufficient" && input.allowRegistrationAfterScopeExpansion !== true)
				return result("registration_scope_insufficient");
			return result("dynamic_registration");
		}
	}
	return result(
		status === "scope_insufficient" ? "registration_scope_insufficient" : "manual_client_required",
	);
}

/** Canonical HTTPS web callback or RFC 8252 loopback HTTP native callback; no network admission. */
export function getMcpClientOAuthApplicationType(value: string): "web" | "native" | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
	try {
		const url = new URL(value);
		if (url.href !== value || url.username !== "" || url.password !== "" || url.hash !== "")
			return undefined;
		if (url.protocol === "https:") return "web";
		if (
			url.protocol === "http:" &&
			(url.hostname === "localhost" ||
				url.hostname === "[::1]" ||
				/^127\.\d+\.\d+\.\d+$/u.test(url.hostname))
		)
			return "native";
	} catch {
		/* Invalid URLs are not provisioning capabilities. */
	}
	return undefined;
}

/** Empty or absent discovery asks for no scopes; it never expands a registered allowance. */
export function mcpClientOAuthScopesCover(
	available: readonly string[],
	requested: readonly string[] = [],
): boolean {
	validateScopes(available);
	validateScopes(requested);
	const allowed = new Set(available);
	return requested.every((scope) => allowed.has(scope));
}

function existingClientStatus(
	existing: McpClientOAuthExistingClient | undefined,
	ready: McpClientOAuthBootstrapReady,
	redirectUri: string,
	metadataUrl: string | undefined,
): McpClientOAuthExistingClientStatus {
	if (existing === undefined) return "absent";
	if (
		existing.serverUrl !== ready.resource.serverUrl ||
		existing.issuer !== ready.candidate.authority.issuer ||
		existing.resource !== ready.resource.resource ||
		(existing.provisioningMethod !== "manual" && existing.redirectUri !== redirectUri) ||
		(existing.provisioningMethod === "client_id_metadata" &&
			(!ready.candidate.clientIdMetadataDocumentSupported ||
				metadataUrl === undefined ||
				existing.clientId !== metadataUrl)) ||
		!ready.candidate.authority.tokenEndpointAuthMethodsSupported.includes(
			existing.authenticationMethod,
		) ||
		(existing.authenticationMethod !== "none" && !existing.authenticationAvailable)
	)
		return "incompatible";
	return existing.provisioningMethod === "dynamic_registration" &&
		!mcpClientOAuthScopesCover(existing.scopes, ready.scopes)
		? "scope_insufficient"
		: "reusable";
}

function captureExistingClient(value: McpClientOAuthExistingClient): McpClientOAuthExistingClient {
	return parseOAuthSnapshot(value, {}, (record) => {
		assertOAuthSnapshotKeys(record, [
			"clientId",
			"serverUrl",
			"issuer",
			"resource",
			"provisioningMethod",
			"authenticationMethod",
			"authenticationAvailable",
			"redirectUri",
			"scopes",
		]);
		const method = record.provisioningMethod;
		const authentication = record.authenticationMethod;
		if (method !== "manual" && method !== "client_id_metadata" && method !== "dynamic_registration")
			throw invalidOptions();
		if (
			authentication !== "none" &&
			authentication !== "client_secret_basic" &&
			authentication !== "client_secret_post" &&
			authentication !== "private_key_jwt"
		)
			throw invalidOptions();
		const scopes = oauthSnapshotStrings(record.scopes, 128);
		validateScopes(scopes);
		return Object.freeze({
			clientId: oauthSnapshotString(record.clientId, 2_048),
			serverUrl: oauthSnapshotString(record.serverUrl, 4_096),
			issuer: oauthSnapshotString(record.issuer, 4_096),
			resource: oauthSnapshotString(record.resource, 4_096),
			provisioningMethod: method,
			authenticationMethod: authentication,
			authenticationAvailable: oauthSnapshotBoolean(record.authenticationAvailable),
			...(record.redirectUri === undefined
				? {}
				: { redirectUri: oauthSnapshotString(record.redirectUri, 4_096) }),
			scopes: Object.freeze([...scopes]),
		});
	});
}

function validateScopes(value: readonly string[]): void {
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		!value.every(isMcpClientOAuthScopeToken) ||
		value.join(" ").length > 4_096
	)
		throw invalidOptions();
}

function invalidOptions(): TypeError {
	return new TypeError("The MCP OAuth provisioning options are invalid.");
}
