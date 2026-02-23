import { MCP_PROMPT_METADATA } from '@btwld/mcp-common';
import type { PromptOptions, PromptMetadata } from '@btwld/mcp-common';

export function Prompt(options: PromptOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: PromptMetadata = {
      name: options.name || String(propertyKey),
      description: options.description,
      parameters: options.parameters,
      methodName: String(propertyKey),
      target: target.constructor,
    };

    Reflect.defineMetadata(MCP_PROMPT_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
