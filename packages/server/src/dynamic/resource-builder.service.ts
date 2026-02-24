import type { McpExecutionContext, ResourceReadResult } from '@btwld/mcp-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredResource } from '../discovery/registry.service';

export interface DynamicResourceConfig {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: (uri: URL, ctx: McpExecutionContext) => Promise<ResourceReadResult | string | unknown>;
}

@Injectable()
export class McpResourceBuilder {
  private readonly logger = new Logger(McpResourceBuilder.name);

  constructor(@Inject(McpRegistryService) private readonly registry: McpRegistryService) {}

  register(config: DynamicResourceConfig): void {
    const handlerWrapper = {
      [config.name]: config.handler,
    };

    const registered: RegisteredResource = {
      uri: config.uri,
      name: config.name,
      description: config.description,
      mimeType: config.mimeType,
      methodName: config.name,
      target: handlerWrapper.constructor as abstract new (...args: unknown[]) => unknown,
      instance: handlerWrapper,
    };

    this.registry.registerResource(registered);
  }

  unregister(uri: string): boolean {
    return this.registry.unregisterResource(uri);
  }
}
