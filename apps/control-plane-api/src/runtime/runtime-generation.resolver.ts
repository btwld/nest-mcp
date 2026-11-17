import { Inject, Injectable } from "@nestjs/common";
import type { McpAdmittedRuntimeGeneration, McpRuntimeGenerationResolver } from "@nest-mcp/manager";

import { ConnectionRepository } from "../connections/connection.repository.ts";
import { VolatileOAuthAuthorityService } from "../oauth/volatile-oauth-authority.service.ts";
import { McpEndpointAdmissionService } from "./mcp-endpoint-admission.service.ts";

@Injectable()
export class InMemoryRuntimeGenerationResolver implements McpRuntimeGenerationResolver {
	constructor(
		@Inject(ConnectionRepository) private readonly connections: ConnectionRepository,
		@Inject(McpEndpointAdmissionService) private readonly admission: McpEndpointAdmissionService,
		@Inject(VolatileOAuthAuthorityService)
		private readonly oauth: VolatileOAuthAuthorityService,
	) {}

	async resolve(generationKey: string, signal: AbortSignal): Promise<McpAdmittedRuntimeGeneration> {
		throwIfAborted(signal);
		const connection = this.connections.resolveGeneration(generationKey);
		const admitted = this.admission.admit(connection.endpoint);
		throwIfAborted(signal);
		const oauthLease =
			connection.authenticationKind === "oauth"
				? this.oauth.acquireRuntimeBridge(connection.generationKey)
				: undefined;
		return Object.freeze({
			transport: Object.freeze({
				kind: "http" as const,
				url: admitted.url,
				fetch: this.admission.createFetch(admitted.url),
				...(oauthLease === undefined ? {} : { authProvider: oauthLease.authProvider }),
				...(oauthLease === undefined
					? {}
					: { options: Object.freeze({ onInsufficientScope: "throw" as const }) }),
			}),
			close: async () => oauthLease?.close(),
		});
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason;
}
