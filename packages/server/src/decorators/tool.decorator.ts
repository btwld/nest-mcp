import { MCP_TOOL_METADATA } from '@btwld/mcp-common';
import type { ToolMetadata, ToolOptions } from '@btwld/mcp-common';

export function Tool(options: ToolOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ToolMetadata = {
      name: options.name || String(propertyKey),
      description: options.description,
      parameters: options.parameters,
      outputSchema: options.outputSchema,
      annotations: options.annotations,
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_TOOL_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
