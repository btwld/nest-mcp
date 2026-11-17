import type {
  Icon,
  McpExecutionContext,
  ToolAnnotations,
  ToolCallResult,
  ToolExecution,
} from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import type { ZodType } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';

export interface DynamicToolConfig {
  name: string;
  /** Human-readable display title (surfaced in `tools/list`). */
  title?: string;
  description: string;
  parameters?: ZodType;
  inputSchema?: Record<string, unknown>;
  outputSchema?: ZodType;
  /** Raw JSON schema for output — used when no Zod outputSchema is available (e.g. gateway-proxied tools). */
  rawOutputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  /** Execution hints surfaced in `tools/list` (e.g. `{ taskSupport: 'forbidden' }`). */
  execution?: ToolExecution;
  /** Free-form metadata surfaced as the tool's `_meta` in `tools/list`. */
  _meta?: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ) => Promise<ToolCallResult | string | unknown>;
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
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      rawOutputSchema: config.rawOutputSchema,
      annotations: config.annotations,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.icons ? { icons: config.icons } : {}),
      ...(config.execution ? { execution: config.execution } : {}),
      ...(config._meta ? { _meta: config._meta } : {}),
      methodName: config.name,
      target: handlerWrapper.constructor as abstract new (...args: unknown[]) => unknown,
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
