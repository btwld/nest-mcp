import { Module } from "@nestjs/common";

import { McpRuntimeModule } from "../runtime/mcp-runtime.module.ts";
import { HealthController } from "./health.controller.ts";

@Module({
	imports: [McpRuntimeModule],
	controllers: [HealthController],
})
export class HealthModule {}
