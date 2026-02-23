import { Injectable, Logger } from '@nestjs/common';
import type { ZodObject } from 'zod';
import type { McpExecutionContext, PromptGetResult } from '@btwld/mcp-common';
import { McpRegistryService, type RegisteredPrompt } from '../discovery/registry.service';

export interface DynamicPromptConfig {
  name: string;
  description: string;
  parameters?: ZodObject<any>;
  handler: (args: any, ctx: McpExecutionContext) => Promise<PromptGetResult>;
}

@Injectable()
export class McpPromptBuilder {
  private readonly logger = new Logger(McpPromptBuilder.name);

  constructor(private readonly registry: McpRegistryService) {}

  register(config: DynamicPromptConfig): void {
    const handlerWrapper = {
      [config.name]: config.handler,
    };

    const registered: RegisteredPrompt = {
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      methodName: config.name,
      target: handlerWrapper.constructor,
      instance: handlerWrapper,
    };

    this.registry.registerPrompt(registered);
  }

  unregister(name: string): boolean {
    return this.registry.unregisterPrompt(name);
  }
}
