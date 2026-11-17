import type {
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { createOAuthState, createOAuthStateLookupDigest } from "@nest-mcp/client/oauth";

interface AuthorizationRedirectSnapshot {
	readonly authorizationUrl: string;
	readonly stateDigest: string;
	readonly createdAtMs: number;
}

/** One volatile browser-authorization session. Secret-bearing members never leave this class. */
export class VolatileOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl: URL;
	readonly clientMetadata: OAuthClientMetadata;
	readonly #clientInformation = new Map<string, StoredOAuthClientInformation>();
	readonly #tokens = new Map<string, StoredOAuthTokens>();
	#latestIssuer: string | undefined;
	#codeVerifier: string | undefined;
	#discovery: OAuthDiscoveryState | undefined;
	#resourceUrl: string | undefined;
	#stateDigest: string | undefined;
	#stateCreatedAtMs: number | undefined;
	#authorizationUrl: string | undefined;

	constructor(options: { readonly redirectUrl: string; readonly clientName: string }) {
		this.redirectUrl = new URL(options.redirectUrl);
		this.clientMetadata = Object.freeze({
			client_name: options.clientName,
			redirect_uris: [this.redirectUrl.href],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
	}

	state(): string {
		const value = createOAuthState();
		this.#stateDigest = createOAuthStateLookupDigest(value);
		this.#stateCreatedAtMs = Date.now();
		return value;
	}

	clientInformation(
		context?: OAuthClientInformationContext,
	): StoredOAuthClientInformation | undefined {
		const issuer = context?.issuer ?? this.#latestIssuer;
		return issuer === undefined ? undefined : this.#clientInformation.get(issuer);
	}

	saveClientInformation(
		clientInformation: StoredOAuthClientInformation,
		context?: OAuthClientInformationContext,
	): void {
		const issuer = context?.issuer ?? clientInformation.issuer;
		if (issuer === undefined) throw new Error("OAuth client information has no issuer binding.");
		this.#latestIssuer = issuer;
		this.#clientInformation.set(issuer, freezeCopy(clientInformation));
	}

	tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
		const issuer = context?.issuer ?? this.#latestIssuer;
		return issuer === undefined ? undefined : this.#tokens.get(issuer);
	}

	saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): void {
		const issuer = context?.issuer ?? tokens.issuer;
		if (issuer === undefined) throw new Error("OAuth tokens have no issuer binding.");
		this.#latestIssuer = issuer;
		this.#tokens.set(issuer, freezeCopy(tokens));
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		const state = authorizationUrl.searchParams.get("state");
		if (
			state === null ||
			this.#stateDigest === undefined ||
			createOAuthStateLookupDigest(state) !== this.#stateDigest
		) {
			throw new Error("OAuth authorization state was not preserved.");
		}
		this.#authorizationUrl = authorizationUrl.href;
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.#codeVerifier = codeVerifier;
	}

	codeVerifier(): string {
		if (this.#codeVerifier === undefined) throw new Error("OAuth PKCE verifier is unavailable.");
		return this.#codeVerifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.#discovery = freezeCopy(state);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#discovery;
	}

	saveResourceUrl(resourceUrl: string): void {
		this.#resourceUrl = resourceUrl;
	}

	resourceUrl(): string | undefined {
		return this.#resourceUrl;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all" || scope === "client") this.#clientInformation.clear();
		if (scope === "all" || scope === "tokens") this.#tokens.clear();
		if (scope === "all" || scope === "verifier") this.#codeVerifier = undefined;
		if (scope === "all" || scope === "discovery") this.#discovery = undefined;
		if (scope === "all") {
			this.#latestIssuer = undefined;
			this.#resourceUrl = undefined;
			this.#stateDigest = undefined;
			this.#stateCreatedAtMs = undefined;
			this.#authorizationUrl = undefined;
		}
	}

	takeAuthorizationRedirect(): AuthorizationRedirectSnapshot {
		if (
			this.#authorizationUrl === undefined ||
			this.#stateDigest === undefined ||
			this.#stateCreatedAtMs === undefined
		) {
			throw new Error("OAuth authorization redirect is unavailable.");
		}
		const snapshot = Object.freeze({
			authorizationUrl: this.#authorizationUrl,
			stateDigest: this.#stateDigest,
			createdAtMs: this.#stateCreatedAtMs,
		});
		this.#authorizationUrl = undefined;
		return snapshot;
	}

	currentAccessToken(): string | undefined {
		return this.tokens()?.access_token;
	}

	issuer(): string | undefined {
		return this.#latestIssuer;
	}

	clearAuthorizationTransaction(): void {
		this.#codeVerifier = undefined;
		this.#stateDigest = undefined;
		this.#stateCreatedAtMs = undefined;
		this.#authorizationUrl = undefined;
	}
}

function freezeCopy<Value extends object>(value: Value): Value {
	return Object.freeze(structuredClone(value));
}
