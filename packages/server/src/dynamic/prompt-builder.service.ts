import type { Icon, McpExecutionContext, PromptGetResult } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { type ZodObject, type ZodRawShape, type ZodType, z } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredPrompt } from '../discovery/registry.service';

/**
 * A prompt argument described in plain MCP terms, for prompts whose
 * arguments come from somewhere other than a Zod schema (e.g. a proxied
 * upstream's `prompts/list`). Prompt argument values are strings.
 */
export interface DynamicPromptArgument {
  name: string;
  /** Human-readable display title. */
  title?: string;
  description?: string;
  required?: boolean;
}

export interface DynamicPromptConfig {
  name: string;
  /** Human-readable display title (surfaced in `prompts/list`). */
  title?: string;
  description: string;
  parameters?: ZodObject<ZodRawShape>;
  /**
   * Raw argument definitions, used when `parameters` is not given. They are
   * advertised in `prompts/list` (name, description, required) and every
   * declared argument is passed to the handler as a string.
   */
  arguments?: DynamicPromptArgument[];
  icons?: Icon[];
  /** Free-form metadata surfaced as the prompt's `_meta` in `prompts/list`. */
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpExecutionContext) => Promise<PromptGetResult>;
}

/** Build the string-valued argument schema for raw prompt arguments. */
function schemaFromArguments(args: DynamicPromptArgument[]): ZodObject<ZodRawShape> {
  const shape: Record<string, ZodType> = {};
  for (const arg of args) {
    let field: ZodType = arg.required ? z.string() : z.string().optional();
    if (arg.description) field = field.describe(arg.description);
    shape[arg.name] = field;
  }
  return z.object(shape);
}

@Injectable()
export class McpPromptBuilder {
  private readonly logger = new Logger(McpPromptBuilder.name);

  constructor(private readonly registry: McpRegistryService) {}

  register(config: DynamicPromptConfig): void {
    const handlerWrapper = {
      [config.name]: config.handler,
    };

    const parameters =
      config.parameters ?? (config.arguments ? schemaFromArguments(config.arguments) : undefined);

    const registered: RegisteredPrompt = {
      name: config.name,
      description: config.description,
      parameters,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.icons ? { icons: config.icons } : {}),
      ...(config._meta ? { _meta: config._meta } : {}),
      methodName: config.name,
      target: handlerWrapper.constructor as abstract new (...args: unknown[]) => unknown,
      instance: handlerWrapper,
    };

    this.registry.registerPrompt(registered);
  }

  unregister(name: string): boolean {
    return this.registry.unregisterPrompt(name);
  }
}
