import type { Icon, McpExecutionContext, ResourceReadResult } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredResource } from '../discovery/registry.service';

export interface DynamicResourceConfig {
  uri: string;
  name: string;
  /** Human-readable display title (surfaced in `resources/list`). */
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  /** Free-form metadata surfaced as the resource's `_meta` in `resources/list`. */
  _meta?: Record<string, unknown>;
  handler: (uri: URL, ctx: McpExecutionContext) => Promise<ResourceReadResult | string | unknown>;
}

@Injectable()
export class McpResourceBuilder {
  private readonly logger = new Logger(McpResourceBuilder.name);

  constructor(private readonly registry: McpRegistryService) {}

  register(config: DynamicResourceConfig): void {
    const handlerWrapper = {
      [config.name]: config.handler,
    };

    const registered: RegisteredResource = {
      uri: config.uri,
      name: config.name,
      description: config.description,
      mimeType: config.mimeType,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.icons ? { icons: config.icons } : {}),
      ...(config._meta ? { _meta: config._meta } : {}),
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
