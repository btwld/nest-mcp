import { Module } from "@nestjs/common";
import { createStreamingSsrfGuardedFetch } from "@nest-mcp/auth/cimd";

import { ConnectionStoreModule } from "../connections/connection-store.module.ts";
import { ControlPlaneConfigModule } from "../config/control-plane-config.module.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { OAuthAuthorityModule } from "../oauth/oauth-authority.module.ts";
import { McpEndpointAdmissionService } from "./mcp-endpoint-admission.service.ts";
import { InMemoryRuntimeGenerationResolver } from "./runtime-generation.resolver.ts";
import { MCP_CONTROL_PLANE_GUARDED_FETCH, type McpGuardedTransportFetch } from "./runtime.types.ts";

/**
 * Every outbound MCP transport request runs through Nest MCP's streaming guarded
 * fetch: connect-time DNS pinning, blocked private ranges, refused redirects,
 * and byte fences (total for ordinary responses, per-event for SSE). This host
 * supplies only policy — its configured host allowlist and its dev-loopback
 * switch.
 */
export function createGuardedTransportFetch(
	config: ControlPlaneConfigService,
): McpGuardedTransportFetch {
	return createStreamingSsrfGuardedFetch({
		allowedHosts: config.allowedHosts,
		allowLoopbackHttp: config.allowLoopbackHttp,
	});
}

@Module({
	imports: [ControlPlaneConfigModule, ConnectionStoreModule, OAuthAuthorityModule],
	providers: [
		{
			provide: MCP_CONTROL_PLANE_GUARDED_FETCH,
			inject: [ControlPlaneConfigService],
			useFactory: createGuardedTransportFetch,
		},
		McpEndpointAdmissionService,
		InMemoryRuntimeGenerationResolver,
	],
	exports: [McpEndpointAdmissionService, InMemoryRuntimeGenerationResolver],
})
export class RuntimeGenerationModule {}
