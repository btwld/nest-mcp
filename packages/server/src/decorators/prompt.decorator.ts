import { MCP_PROMPT_METADATA } from '@nest-mcp/common';
import type { PromptMetadata, PromptOptions } from '@nest-mcp/common';

export function Prompt(options: PromptOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: PromptMetadata = {
      name: options.name || String(propertyKey),
      ...(options.title != null ? { title: options.title } : {}),
      description: options.description,
      parameters: options.parameters,
      ...(options.icons != null ? { icons: options.icons } : {}),
      ...('_meta' in options && options._meta != null ? { _meta: options._meta } : {}),
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_PROMPT_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
