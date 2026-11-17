import { Module } from "@nestjs/common";

import { HubModule } from "../hub/hub.module.ts";
import { McpRuntimeModule } from "../runtime/mcp-runtime.module.ts";
import { OAuthAuthorityModule } from "../oauth/oauth-authority.module.ts";
import { ConnectionControlService } from "./connection-control.service.ts";
import { ConnectionController } from "./connection.controller.ts";
import { ConnectionStoreModule } from "./connection-store.module.ts";
import { RuntimeController } from "./runtime.controller.ts";

@Module({
	imports: [ConnectionStoreModule, McpRuntimeModule, HubModule, OAuthAuthorityModule],
	controllers: [ConnectionController, RuntimeController],
	providers: [ConnectionControlService],
	exports: [ConnectionControlService],
})
export class ConnectionControlModule {}
