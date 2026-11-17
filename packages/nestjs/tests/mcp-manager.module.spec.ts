import { Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { McpLifecycleObserver } from "@nest-mcp/core";
import { McpRuntimeManager, type McpRuntimeGenerationResolver } from "@nest-mcp/manager";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpManagerModule, McpManagerService } from "../src/manager/index.ts";

const GENERATION_RESOLVER = Symbol("GENERATION_RESOLVER");
const LIFECYCLE_OBSERVER = Symbol("LIFECYCLE_OBSERVER");
const MANAGER_CLOCK = Symbol("MANAGER_CLOCK");
const LISTENER_ERROR_REPORTER = Symbol("LISTENER_ERROR_REPORTER");
const ASYNC_MAX_CONNECTIONS = Symbol("ASYNC_MAX_CONNECTIONS");

@Module({
	providers: [{ provide: ASYNC_MAX_CONNECTIONS, useValue: 7 }],
	exports: [ASYNC_MAX_CONNECTIONS],
})
class AsyncManagerConfigurationModule {}

describe("McpManagerModule", () => {
	let application: INestApplication | undefined;

	afterEach(async () => {
		await application?.close();
		application = undefined;
		vi.restoreAllMocks();
	});

	it("resolves provider-token collaborators and aliases the neutral manager", async () => {
		const resolver = createResolver();
		const observer: McpLifecycleObserver = { onEvent: vi.fn() };
		const clock = { now: vi.fn(() => 1_700_000_000_000) };
		const listenerErrorReporter = { report: vi.fn() };
		const dynamicModule = McpManagerModule.forRoot({
			generationResolver: GENERATION_RESOLVER,
			observer: LIFECYCLE_OBSERVER,
			clock: MANAGER_CLOCK,
			listenerErrorReporter: LISTENER_ERROR_REPORTER,
			maxConnections: 3,
			collaborators: {
				providers: [
					{ provide: GENERATION_RESOLVER, useValue: resolver },
					{ provide: LIFECYCLE_OBSERVER, useValue: observer },
					{ provide: MANAGER_CLOCK, useValue: clock },
					{ provide: LISTENER_ERROR_REPORTER, useValue: listenerErrorReporter },
				],
			},
		});
		expect(dynamicModule.global).toBe(false);

		const testingModule = await Test.createTestingModule({
			imports: [dynamicModule],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const service = application.get(McpManagerService);
		expect(application.get(McpRuntimeManager)).toBe(service);
		expect(service.snapshot()).toMatchObject({
			closed: false,
			maxConnections: 3,
		});
		service.subscribe(() => {
			throw new Error("controlled listener failure");
		});
		await service.setOffline("unused-generation");
		expect(listenerErrorReporter.report).toHaveBeenCalled();
		expect(service.state("unused-generation").lastTransitionAt).toBe("2023-11-14T22:13:20.000Z");
	});

	it("supports asynchronous options factories and deterministic Nest shutdown", async () => {
		const createOptions = vi.fn((maxConnections: number) => ({
			generationResolver: GENERATION_RESOLVER,
			maxConnections,
		}));
		const dynamicModule = McpManagerModule.forRootAsync({
			imports: [AsyncManagerConfigurationModule],
			inject: [ASYNC_MAX_CONNECTIONS],
			useFactory: createOptions,
			collaborators: {
				providers: [{ provide: GENERATION_RESOLVER, useValue: createResolver() }],
			},
		});
		const testingModule = await Test.createTestingModule({
			imports: [dynamicModule],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpManagerService);

		expect(createOptions).toHaveBeenCalledWith(7);
		expect(service.snapshot()).toMatchObject({
			closed: false,
			maxConnections: 7,
		});
		await application.close();
		application = undefined;
		expect(service.snapshot().closed).toBe(true);
	});
});

function createResolver(): McpRuntimeGenerationResolver {
	return {
		resolve: vi.fn(async () => ({
			transport: { kind: "http" as const, url: "https://mcp.example.test" },
			close: async () => undefined,
		})),
	};
}
