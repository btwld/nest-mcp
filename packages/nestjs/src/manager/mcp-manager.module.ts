import { Module, type DynamicModule } from "@nestjs/common";
import { McpRuntimeManager } from "@nest-mcp/manager";

import {
	ConfigurableMcpManagerModuleClass,
	type McpManagerForRootAsyncOptions,
	type McpManagerForRootOptions,
} from "./mcp-manager.module-definition.ts";
import { McpManagerService } from "./mcp-manager.service.ts";

@Module({
	providers: [McpManagerService, { provide: McpRuntimeManager, useExisting: McpManagerService }],
	exports: [McpManagerService, McpRuntimeManager],
})
export class McpManagerModule extends ConfigurableMcpManagerModuleClass {
	static override forRoot(options: McpManagerForRootOptions): DynamicModule {
		return super.forRoot(options);
	}

	static override forRootAsync(options: McpManagerForRootAsyncOptions): DynamicModule {
		return super.forRootAsync(options);
	}
}
