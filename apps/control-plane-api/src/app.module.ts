import { BadRequestException, Module } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";

import { ApiExceptionFilter } from "./common/api-exception.filter.ts";
import { StandardSchemaDtoValidationPipe } from "./common/standard-schema-dto.ts";
import { ConnectionControlModule } from "./connections/connection-control.module.ts";
import { ConformanceModule } from "./conformance/conformance.module.ts";
import { ControlPlaneConfigModule } from "./config/control-plane-config.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { OAuthControlModule } from "./oauth/oauth-control.module.ts";

@Module({
	imports: [
		ControlPlaneConfigModule,
		ConnectionControlModule,
		ConformanceModule,
		OAuthControlModule,
		HealthModule,
	],
	providers: [
		{ provide: APP_FILTER, useClass: ApiExceptionFilter },
		{
			provide: APP_PIPE,
			useFactory: () =>
				new StandardSchemaDtoValidationPipe({
					exceptionFactory: (issues) =>
						new BadRequestException(
							issues.map((issue) => {
								const path = issue.path
									?.map((segment) => String(typeof segment === "object" ? segment.key : segment))
									.join(".");
								return path === undefined || path.length === 0
									? issue.message
									: `${path}: ${issue.message}`;
							}),
						),
				}),
		},
	],
})
export class AppModule {}
