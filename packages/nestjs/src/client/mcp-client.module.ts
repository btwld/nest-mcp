import { Module, type DynamicModule } from "@nestjs/common";
import { McpClientRuntime } from "@nest-mcp/client";
import {
	ConfigurableMcpClientModuleClass,
	type McpClientForRootAsyncOptions,
	type McpClientForRootOptions,
} from "./mcp-client.module-definition.ts";
import { McpClientService } from "./mcp-client.service.ts";

@Module({
	providers: [McpClientService, { provide: McpClientRuntime, useExisting: McpClientService }],
	exports: [McpClientService, McpClientRuntime],
})
export class McpClientModule extends ConfigurableMcpClientModuleClass {
	static override forRoot(options: McpClientForRootOptions = {}): DynamicModule {
		return super.forRoot(options);
	}

	static override forRootAsync(options: McpClientForRootAsyncOptions): DynamicModule {
		return super.forRootAsync(options);
	}
}
