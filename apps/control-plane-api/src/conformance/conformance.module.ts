import { Module } from "@nestjs/common";

import { ControlPlaneConfigModule } from "../config/control-plane-config.module.ts";
import { ConnectionStoreModule } from "../connections/connection-store.module.ts";
import { OAuthAuthorityModule } from "../oauth/oauth-authority.module.ts";
import { McpRuntimeModule } from "../runtime/mcp-runtime.module.ts";
import { ConformanceController } from "./conformance.controller.ts";
import { ConformanceRunRepository } from "./conformance.repository.ts";
import { ConformanceService } from "./conformance.service.ts";

@Module({
	imports: [
		ControlPlaneConfigModule,
		ConnectionStoreModule,
		OAuthAuthorityModule,
		McpRuntimeModule,
	],
	controllers: [ConformanceController],
	providers: [ConformanceRunRepository, ConformanceService],
})
export class ConformanceModule {}
