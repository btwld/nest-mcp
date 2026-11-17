import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { McpRuntimeManagerPort } from "@nest-mcp/manager";

import { MCP_RUNTIME_SUPERVISOR } from "../runtime/runtime.types.ts";

@ApiTags("Health")
@Controller("health")
export class HealthController {
	constructor(
		@Inject(MCP_RUNTIME_SUPERVISOR)
		private readonly runtime: McpRuntimeManagerPort,
	) {}

	@Get("live")
	@ApiOkResponse({ schema: { type: "object", properties: { status: { enum: ["live"] } } } })
	live(): { readonly status: "live" } {
		return Object.freeze({ status: "live" });
	}

	@Get("ready")
	@ApiOkResponse({ schema: { type: "object", properties: { status: { enum: ["ready"] } } } })
	ready(): { readonly status: "ready" } {
		if (this.runtime.snapshot().closed) {
			throw new ServiceUnavailableException("The MCP runtime supervisor is closed.");
		}
		return Object.freeze({ status: "ready" });
	}
}
