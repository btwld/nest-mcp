import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { ConnectionLifecycleCoordinator } from "../src/connections/connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "../src/connections/connection.repository.ts";
import { HubService } from "../src/hub/hub.service.ts";
import { OAuthControlService } from "../src/oauth/oauth-control.service.ts";
import { VolatileOAuthAuthorityService } from "../src/oauth/volatile-oauth-authority.service.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../src/runtime/runtime.types.ts";

describe("OAuthControlService", () => {
	it("drains and fences the current generation before beginning browser authorization", async () => {
		const events: string[] = [];
		const connections = new ConnectionRepository();
		const connection = connections.create({
			displayName: "OAuth upstream",
			desiredState: "online",
			authenticationKind: "oauth",
			endpoint: "https://resource.example.test/mcp",
			endpointHost: "resource.example.test",
		});
		const authority = {
			resetConnection: vi.fn(() => events.push("reset")),
			beginAuthorization: vi.fn(async () => {
				events.push("begin");
				return "https://auth.example.test/authorize?state=opaque";
			}),
		};
		const service = await createService({
			connections,
			authority,
			runtime: {
				setOffline: vi.fn(async () => {
					events.push("offline");
					return runtimeState("offline");
				}),
			},
			hub: { detachConnection: vi.fn(async () => events.push("detach")) },
		});

		await expect(service.authorize(connection.id, connection.revision)).resolves.toContain(
			"auth.example.test",
		);
		expect(events).toEqual(["detach", "offline", "reset", "begin"]);
		expect(connections.get(connection.id)).toMatchObject({
			desiredState: "offline",
			revision: 2,
			runtimeGeneration: 1,
		});
	});

	it("resets the OAuth projection even when draining the prior runtime fails", async () => {
		const events: string[] = [];
		const connections = new ConnectionRepository();
		const connection = connections.create({
			displayName: "OAuth drain failure",
			desiredState: "offline",
			authenticationKind: "oauth",
			endpoint: "https://resource.example.test/mcp",
			endpointHost: "resource.example.test",
		});
		const authority = {
			resetConnection: vi.fn(() => events.push("reset")),
			beginAuthorization: vi.fn(async () => "https://auth.example.test/authorize"),
		};
		const service = await createService({
			connections,
			authority,
			runtime: {
				setOffline: vi.fn(async () => {
					events.push("offline");
					throw new Error("quarantined");
				}),
			},
			hub: { detachConnection: vi.fn(async () => events.push("detach")) },
		});

		await expect(service.authorize(connection.id, connection.revision)).rejects.toThrow(
			"quarantined",
		);
		expect(events).toEqual(["detach", "offline", "reset"]);
		expect(authority.beginAuthorization).not.toHaveBeenCalled();
	});

	it("keeps a successful callback authorized when retired-generation cleanup is quarantined", async () => {
		const events: string[] = [];
		const connections = new ConnectionRepository();
		const connection = connections.create({
			displayName: "OAuth callback",
			desiredState: "offline",
			authenticationKind: "oauth",
			endpoint: "https://resource.example.test/mcp",
			endpointHost: "resource.example.test",
		});
		const attempt = {
			connectionId: connection.id,
			generationKey: connection.generationKey,
			endpoint: connection.endpoint,
		};
		const prepared = { marker: "prepared" };
		const authority = {
			takeCallback: vi.fn(() => ({ attempt, callback: { kind: "success" } })),
			exchangeCallback: vi.fn(async () => prepared),
			publishAuthorization: vi.fn(() => events.push("publish")),
			fenceGeneration: vi.fn(() => events.push("fence")),
			discardPrepared: vi.fn(),
			discardTaken: vi.fn(),
		};
		const service = await createService({
			connections,
			authority,
			runtime: {
				retire: vi.fn(async () => {
					events.push("retire");
					throw new Error("quarantined");
				}),
			},
			hub: { detachConnection: vi.fn(async () => events.push("detach")) },
		});

		await expect(service.completeCallback(new URLSearchParams())).resolves.toEqual({
			oauth: "authorized",
			connectionId: connection.id,
		});
		expect(events).toEqual(["detach", "publish", "retire", "fence"]);
		expect(connections.get(connection.id)).toMatchObject({ revision: 2, runtimeGeneration: 2 });
		expect(authority.publishAuthorization).toHaveBeenCalledWith(
			prepared,
			connections.get(connection.id).generationKey,
		);
	});
});

async function createService(options: {
	readonly connections: ConnectionRepository;
	readonly authority: object;
	readonly runtime: object;
	readonly hub: object;
}): Promise<OAuthControlService> {
	const module = await Test.createTestingModule({
		providers: [
			OAuthControlService,
			ConnectionLifecycleCoordinator,
			{ provide: ConnectionRepository, useValue: options.connections },
			{ provide: VolatileOAuthAuthorityService, useValue: options.authority },
			{ provide: MCP_RUNTIME_SUPERVISOR, useValue: options.runtime },
			{ provide: HubService, useValue: options.hub },
			{ provide: ControlPlaneConfigService, useValue: { uiOrigin: "http://127.0.0.1:5173" } },
		],
	}).compile();
	return module.get(OAuthControlService);
}

function runtimeState(phase: "offline") {
	return Object.freeze({ phase, lastTransitionAt: new Date().toISOString() });
}
