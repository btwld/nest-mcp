import { Controller, Inject } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { McpHttpControllerFor, McpRuntimeService } from "@nest-mcp/nestjs";

import { CONTROL_PLANE_HUB_SERVER_NAME } from "./hub.tokens.ts";

const HubMcpControllerBase = McpHttpControllerFor(CONTROL_PLANE_HUB_SERVER_NAME);

@ApiExcludeController()
@Controller("mcp/hub")
export class HubMcpController extends HubMcpControllerBase {
	constructor(@Inject(McpRuntimeService) runtime: McpRuntimeService) {
		super(runtime);
	}
}
