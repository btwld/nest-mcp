import { Injectable } from "@nestjs/common";
import type { McpRuntimeManagerPort } from "@nest-mcp/manager";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { ConnectionLifecycleCoordinator } from "../connections/connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "../connections/connection.repository.ts";
import { HubService } from "../hub/hub.service.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../runtime/runtime.types.ts";
import type { OAuthCallbackOutcome } from "./oauth.types.ts";
import {
	type PreparedOAuthAuthorization,
	VolatileOAuthAuthorityService,
} from "./volatile-oauth-authority.service.ts";
import { Inject } from "@nestjs/common";

@Injectable()
export class OAuthControlService {
	constructor(
		@Inject(ConnectionRepository) private readonly connections: ConnectionRepository,
		@Inject(ConnectionLifecycleCoordinator)
		private readonly lifecycle: ConnectionLifecycleCoordinator,
		@Inject(VolatileOAuthAuthorityService)
		private readonly authority: VolatileOAuthAuthorityService,
		@Inject(MCP_RUNTIME_SUPERVISOR) private readonly runtime: McpRuntimeManagerPort,
		@Inject(HubService) private readonly hub: HubService,
		@Inject(ControlPlaneConfigService) private readonly config: ControlPlaneConfigService,
	) {}

	authorize(connectionId: string, expectedRevision: number): Promise<string> {
		return this.lifecycle.run(connectionId, async () => {
			let connection = this.connections.get(connectionId);
			assertAuthorizable(connection, expectedRevision);
			await this.hub.detachConnection(connection.id);
			if (connection.desiredState === "online") {
				connection = this.connections.setDesiredState(
					connection.id,
					connection.revision,
					"offline",
				);
			}
			try {
				await this.runtime.setOffline(connection.generationKey);
			} finally {
				this.authority.resetConnection(connection.id, connection.generationKey);
			}
			return this.authority.beginAuthorization({
				connectionId,
				generationKey: connection.generationKey,
				endpoint: connection.endpoint,
			});
		});
	}

	async completeCallback(parameters: URLSearchParams): Promise<OAuthCallbackOutcome> {
		let taken;
		try {
			taken = this.authority.takeCallback(parameters);
		} catch (error) {
			return failedOutcome(undefined, safeOAuthErrorCode(error));
		}
		const { attempt } = taken;
		return this.lifecycle.run(attempt.connectionId, async () => {
			let prepared: PreparedOAuthAuthorization | undefined;
			try {
				const connection = this.connections.get(attempt.connectionId);
				if (
					connection.deletionPending ||
					connection.authenticationKind !== "oauth" ||
					connection.generationKey !== attempt.generationKey ||
					connection.endpoint !== attempt.endpoint
				) {
					throw generationRetiredError();
				}
				prepared = await this.authority.exchangeCallback(taken);
				await this.hub.detachConnection(connection.id);
				const replacement = this.connections.rotateRuntimeGeneration(
					connection.id,
					connection.generationKey,
				);
				this.authority.publishAuthorization(prepared, replacement.current.generationKey);
				prepared = undefined;
				this.connections.forgetGeneration(replacement.previous.generationKey);
				try {
					await this.runtime.retire(replacement.previous.generationKey);
				} catch {
					// The old quarantined capacity remains visible without invalidating new authorization.
				} finally {
					this.authority.fenceGeneration(replacement.previous.generationKey);
				}
				if (replacement.current.desiredState === "online") {
					try {
						await this.runtime.ensureOnline(replacement.current.generationKey);
					} catch {
						// Desired state remains authoritative; runtime projection reports the failure.
					}
				}
				return Object.freeze({
					oauth: "authorized" as const,
					connectionId: connection.id,
				});
			} catch (error) {
				const code = safeOAuthErrorCode(error);
				if (prepared !== undefined) this.authority.discardPrepared(prepared);
				else this.authority.discardTaken(taken, code);
				return failedOutcome(attempt.connectionId, code);
			}
		});
	}

	uiRedirect(outcome: OAuthCallbackOutcome): string {
		const redirect = new URL(this.config.uiOrigin ?? "http://127.0.0.1:5173");
		redirect.search = "";
		redirect.hash = "";
		redirect.searchParams.set("oauth", outcome.oauth);
		if (outcome.connectionId !== undefined) {
			redirect.searchParams.set("connectionId", outcome.connectionId);
		}
		if (outcome.code !== undefined) redirect.searchParams.set("code", outcome.code);
		return redirect.href;
	}
}

function assertAuthorizable(
	connection: ReturnType<ConnectionRepository["get"]>,
	expectedRevision: number,
): void {
	if (connection.revision !== expectedRevision) {
		throw new ControlPlaneError(
			"MCP_REVISION_CONFLICT",
			409,
			"The MCP connection changed after it was read.",
		);
	}
	if (connection.deletionPending) {
		throw new ControlPlaneError(
			"MCP_CONNECTION_DELETING",
			409,
			"The MCP connection is fenced for deletion.",
		);
	}
	if (connection.authenticationKind !== "oauth") {
		throw new ControlPlaneError(
			"MCP_OAUTH_AUTHORIZATION_REQUIRED",
			409,
			"The MCP connection is not configured for OAuth.",
		);
	}
}

function failedOutcome(connectionId: string | undefined, code: string): OAuthCallbackOutcome {
	return Object.freeze({
		oauth: "failed" as const,
		...(connectionId === undefined ? {} : { connectionId }),
		code,
	});
}

function safeOAuthErrorCode(error: unknown): string {
	if (error instanceof ControlPlaneError && error.code.startsWith("MCP_OAUTH_")) {
		return error.code;
	}
	if (error instanceof ControlPlaneError && error.code === "MCP_GENERATION_RETIRED") {
		return error.code;
	}
	return "MCP_OAUTH_UPSTREAM_FAILED";
}

function generationRetiredError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_GENERATION_RETIRED",
		409,
		"The requested MCP runtime generation has been retired.",
	);
}
