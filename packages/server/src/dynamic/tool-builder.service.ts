import { Injectable, Logger } from '@nestjs/common';
import type { ZodType } from 'zod';
import type { ToolAnnotations, McpExecutionContext, ToolCallResult } from '@btwld/mcp-common';
import { McpRegistryService, type RegisteredTool } from '../discovery/registry.service';

export interface DynamicToolConfig {
  name: string;
  description: string;
  parameters?: ZodType;
  outputSchema?: ZodType;
  annotations?: ToolAnnotations;
  handler: (args: any, ctx: McpExecutionContext) => Promise<ToolCallResult | string | unknown>;
  scopes?: string[];
  roles?: string[];
  isPublic?: boolean;
}

@Injectable()
export class McpToolBuilder {
  private readonly logger = new Logger(McpToolBuilder.name);

  constructor(private readonly registry: McpRegistryService) {}

  register(config: DynamicToolConfig): void {
    const handlerWrapper = {
      [config.name]: config.handler,
    };

    const registered: RegisteredTool = {
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      outputSchema: config.outputSchema,
      annotations: config.annotations,
      methodName: config.name,
      target: handlerWrapper.constructor,
      instance: handlerWrapper,
      requiredScopes: config.scopes,
      requiredRoles: config.roles,
      isPublic: config.isPublic,
    };

    this.registry.registerTool(registered);
    this.logger.log(`Dynamically registered tool: ${config.name}`);
  }

  unregister(name: string): boolean {
    return this.registry.unregisterTool(name);
  }
}
