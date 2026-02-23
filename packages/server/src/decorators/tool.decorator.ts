import { MCP_TOOL_METADATA } from '@btwld/mcp-common';
import type { ToolOptions, ToolMetadata } from '@btwld/mcp-common';

export function Tool(options: ToolOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ToolMetadata = {
      name: options.name || String(propertyKey),
      description: options.description,
      parameters: options.parameters,
      outputSchema: options.outputSchema,
      annotations: options.annotations,
      methodName: String(propertyKey),
      target: target.constructor,
    };

    Reflect.defineMetadata(MCP_TOOL_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
