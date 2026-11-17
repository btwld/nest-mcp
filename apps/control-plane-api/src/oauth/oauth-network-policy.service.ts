import { Inject, Injectable } from "@nestjs/common";
import type { FetchLike, OAuthDiscoveryState } from "@modelcontextprotocol/client";
import {
	McpDocumentFetchError,
	normalizeGuardedHost,
	type McpDocumentFetchFailure,
} from "@nest-mcp/auth/cimd";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { MCP_OAUTH_GUARDED_FETCH, type McpOAuthGuardedFetch } from "./oauth.types.ts";

/** Guard verdicts this control plane owns as admission, not as an upstream fault. */
const ADMISSION_FAILURES: ReadonlySet<McpDocumentFetchFailure> = new Set([
	"blocked-address",
	"host-not-allowed",
	"insecure-url",
]);

/**
 * OAuth network policy for this host. Scheme, address ranges, DNS pinning, byte
 * fences, and redirect refusal belong to the injected guarded fetch; what stays
 * here is the application's own endpoint pinning: which host may answer a GET,
 * and the exact discovered endpoint a credential-bearing POST may reach.
 */
@Injectable()
export class OAuthNetworkPolicyService {
	readonly #allowedHosts: ReadonlySet<string>;

	constructor(
		@Inject(ControlPlaneConfigService) config: ControlPlaneConfigService,
		@Inject(MCP_OAUTH_GUARDED_FETCH) private readonly guardedFetch: McpOAuthGuardedFetch,
	) {
		this.#allowedHosts = new Set(config.oauthAllowedHosts.map(normalizeGuardedHost));
	}

	createFetch(
		resourceEndpoint: string,
		getDiscovery: () => OAuthDiscoveryState | undefined,
	): FetchLike {
		const resourceOrigin = new URL(resourceEndpoint).origin;
		return async (input, init) => {
			const requested = requestUrl(input);
			const method = requestMethod(input, init);
			this.#assertAllowed(requested, method, resourceOrigin, getDiscovery());
			try {
				return await this.guardedFetch(requested, {
					...(init?.method === undefined ? {} : { method: init.method }),
					...(init?.headers === undefined ? {} : { headers: init.headers }),
					...(init?.body == null ? {} : { body: init.body }),
					...(init?.signal == null ? {} : { signal: init.signal }),
				});
			} catch (error) {
				throw translateGuardFailure(error);
			}
		};
	}

	admitAuthorizationRedirect(
		authorizationUrl: string,
		discovery: OAuthDiscoveryState | undefined,
	): string {
		let redirect: URL;
		let exactEndpoint: URL;
		try {
			redirect = new URL(authorizationUrl);
			exactEndpoint = new URL(discovery?.authorizationServerMetadata?.authorization_endpoint ?? "");
		} catch {
			throw oauthEndpointRejectedError();
		}
		if (
			redirect.protocol !== "https:" ||
			redirect.username.length > 0 ||
			redirect.password.length > 0 ||
			redirect.hash.length > 0 ||
			!this.#allowedHosts.has(normalizeGuardedHost(redirect.hostname)) ||
			redirect.origin !== exactEndpoint.origin ||
			redirect.pathname !== exactEndpoint.pathname
		) {
			throw oauthEndpointRejectedError();
		}
		return redirect.href;
	}

	#assertAllowed(
		endpoint: URL,
		method: string,
		resourceOrigin: string,
		discovery: OAuthDiscoveryState | undefined,
	): void {
		if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) {
			throw oauthEndpointRejectedError();
		}
		const hostname = normalizeGuardedHost(endpoint.hostname);
		if (method === "GET") {
			if (endpoint.origin === resourceOrigin || this.#allowedHosts.has(hostname)) return;
			throw oauthEndpointRejectedError();
		}
		if (method !== "POST" || !this.#allowedHosts.has(hostname) || discovery === undefined) {
			throw oauthEndpointRejectedError();
		}
		const metadata = discovery.authorizationServerMetadata;
		const exactCredentialEndpoints = [metadata?.registration_endpoint, metadata?.token_endpoint]
			.filter((value): value is string => typeof value === "string")
			.map((value) => new URL(value).href);
		if (!exactCredentialEndpoints.includes(endpoint.href)) throw oauthEndpointRejectedError();
	}
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
	if (input instanceof Request) return new URL(input.url);
	return new URL(String(input));
}

function requestMethod(input: Parameters<FetchLike>[0], init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function translateGuardFailure(error: unknown): unknown {
	if (error instanceof McpDocumentFetchError && ADMISSION_FAILURES.has(error.reason)) {
		return oauthEndpointRejectedError();
	}
	return error;
}

function oauthEndpointRejectedError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_OAUTH_ENDPOINT_REJECTED",
		422,
		"An OAuth endpoint is not admitted by this control plane.",
	);
}
