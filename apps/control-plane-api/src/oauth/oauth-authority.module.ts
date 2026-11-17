import { Module } from "@nestjs/common";
import { createSsrfGuardedFetch } from "@nest-mcp/auth/cimd";

import { ControlPlaneConfigModule } from "../config/control-plane-config.module.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { OAuthNetworkPolicyService } from "./oauth-network-policy.service.ts";
import { MCP_OAUTH_GUARDED_FETCH, type McpOAuthGuardedFetch } from "./oauth.types.ts";
import { VolatileOAuthAuthorityService } from "./volatile-oauth-authority.service.ts";

/**
 * The outbound OAuth transport. Its host fence is the union of both allowlists
 * because discovery starts at the MCP resource origin before it reaches the
 * authorization server; the per-request endpoint pinning stays in
 * {@link OAuthNetworkPolicyService}. Loopback HTTP is refused even when MCP
 * transports allow it: the authorization redirect is a browser navigation this
 * host only admits over HTTPS, so the OAuth surface stays HTTPS end to end.
 */
export function createGuardedOAuthFetch(config: ControlPlaneConfigService): McpOAuthGuardedFetch {
	return createSsrfGuardedFetch({
		allowedHosts: [...config.oauthAllowedHosts, ...config.allowedHosts],
		allowLoopbackHttp: false,
		totalTimeoutMs: config.requestTimeoutMs,
	});
}

@Module({
	imports: [ControlPlaneConfigModule],
	providers: [
		{
			provide: MCP_OAUTH_GUARDED_FETCH,
			useFactory: createGuardedOAuthFetch,
			inject: [ControlPlaneConfigService],
		},
		OAuthNetworkPolicyService,
		VolatileOAuthAuthorityService,
	],
	exports: [OAuthNetworkPolicyService, VolatileOAuthAuthorityService],
})
export class OAuthAuthorityModule {}
