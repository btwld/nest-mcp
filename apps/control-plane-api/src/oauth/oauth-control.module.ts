import { Module } from "@nestjs/common";

import { ConnectionStoreModule } from "../connections/connection-store.module.ts";
import { ControlPlaneConfigModule } from "../config/control-plane-config.module.ts";
import { HubModule } from "../hub/hub.module.ts";
import { McpRuntimeModule } from "../runtime/mcp-runtime.module.ts";
import { OAuthAuthorityModule } from "./oauth-authority.module.ts";
import { OAuthControlService } from "./oauth-control.service.ts";
import { OAuthController } from "./oauth.controller.ts";

@Module({
	imports: [
		ControlPlaneConfigModule,
		ConnectionStoreModule,
		OAuthAuthorityModule,
		McpRuntimeModule,
		HubModule,
	],
	controllers: [OAuthController],
	providers: [OAuthControlService],
})
export class OAuthControlModule {}
