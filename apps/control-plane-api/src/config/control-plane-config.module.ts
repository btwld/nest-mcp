import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { ControlPlaneConfigService, validateEnvironment } from "./control-plane-config.service.ts";

@Module({
	imports: [
		ConfigModule.forRoot({
			cache: true,
			isGlobal: true,
			validate: validateEnvironment,
		}),
	],
	providers: [ControlPlaneConfigService],
	exports: [ControlPlaneConfigService],
})
export class ControlPlaneConfigModule {}
