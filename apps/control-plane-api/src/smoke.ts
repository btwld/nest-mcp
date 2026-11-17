import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { McpClientModule, McpClientService } from "@nest-mcp/nestjs/client";
import { McpManagerModule, McpManagerService } from "@nest-mcp/nestjs/manager";
import { McpClientLeaseManager, McpClientRuntime } from "@nest-mcp/client";
import type { McpRuntimeGenerationResolver } from "@nest-mcp/manager";

import { createApplication } from "./bootstrap.ts";

const PUBLIC_MANAGER_RESOLVER = Symbol("PUBLIC_MANAGER_RESOLVER");
const publicManagerResolver: McpRuntimeGenerationResolver = {
	async resolve() {
		throw new Error("The public package smoke does not resolve a generation.");
	},
};

@Module({
	imports: [
		McpClientModule.forRoot(),
		McpManagerModule.forRoot({
			generationResolver: PUBLIC_MANAGER_RESOLVER,
			collaborators: {
				providers: [{ provide: PUBLIC_MANAGER_RESOLVER, useValue: publicManagerResolver }],
			},
		}),
	],
})
class PublicNestjsAdapterSmokeModule {}

export async function runPublicPackageSmoke(): Promise<void> {
	const manager = new McpClientLeaseManager<string, McpClientRuntime>({
		maxResources: 1,
		create: async () => new McpClientRuntime(),
		close: (runtime) => runtime.close(),
	});
	const lease = await manager.acquire("public-export-smoke");
	if (manager.snapshot().activeResourceCount !== 1) {
		throw new Error("The public MCP client lease manager did not expose its active resource.");
	}
	await lease.release();
	await manager.close();

	const adapterContext = await NestFactory.createApplicationContext(
		PublicNestjsAdapterSmokeModule,
		{
			logger: false,
		},
	);
	try {
		if (adapterContext.get(McpClientService).snapshot().length !== 0) {
			throw new Error("The public Nest MCP client adapter did not initialize cleanly.");
		}
		if (adapterContext.get(McpManagerService).snapshot().connectionCount !== 0) {
			throw new Error("The public Nest MCP manager adapter did not initialize cleanly.");
		}
	} finally {
		await adapterContext.close();
	}

	const controlPlane = await createApplication({ logger: false, swagger: true });
	await controlPlane.close();
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
	await runPublicPackageSmoke();
}
