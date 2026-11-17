import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { ConnectionControlService } from "./connection-control.service.ts";
import { RuntimeManagerResponseDto } from "./connection.response.ts";

@ApiTags("MCP runtime")
@Controller("v1/mcp/runtime")
export class RuntimeController {
	constructor(
		@Inject(ConnectionControlService) private readonly control: ConnectionControlService,
	) {}

	@Get()
	@ApiOkResponse({ type: RuntimeManagerResponseDto })
	snapshot() {
		return this.control.runtimeSnapshot();
	}
}
