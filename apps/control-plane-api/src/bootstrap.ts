import type { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module.ts";

export interface CreateApplicationOptions {
	readonly logger?: false;
	readonly module?: Type<unknown>;
	readonly swagger?: boolean;
}

export async function createApplication(
	options: CreateApplicationOptions = {},
): Promise<NestFastifyApplication> {
	const app = await NestFactory.create<NestFastifyApplication>(
		options.module ?? AppModule,
		new FastifyAdapter(),
		options.logger === false ? { logger: false } : {},
	);
	configureApplication(app, { swagger: options.swagger ?? true });
	await app.init();
	await app.getHttpAdapter().getInstance().ready();
	return app;
}

export function configureApplication(
	app: NestFastifyApplication,
	options: { readonly swagger?: boolean } = {},
): void {
	app.enableShutdownHooks();
	if (options.swagger === false) return;
	const document = SwaggerModule.createDocument(
		app,
		new DocumentBuilder()
			.setTitle("Nest MCP control-plane validation API")
			.setDescription(
				"Reference host for validating Nest MCP lifecycle, discovery, and execution through public package exports.",
			)
			.setVersion("0.0.0")
			.build(),
	);
	SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "/openapi.json" });
}
