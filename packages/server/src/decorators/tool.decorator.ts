import { MCP_TOOL_METADATA } from '@nest-mcp/common';
import type { ToolMetadata, ToolOptions } from '@nest-mcp/common';

export function Tool(options: ToolOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ToolMetadata = {
      name: options.name || String(propertyKey),
      ...(options.title != null ? { title: options.title } : {}),
      description: options.description,
      parameters: options.parameters,
      outputSchema: options.outputSchema,
      annotations: options.annotations,
      ...(options.icons != null ? { icons: options.icons } : {}),
      ...(options.execution != null ? { execution: options.execution } : {}),
      ...('_meta' in options && options._meta != null ? { _meta: options._meta } : {}),
      ...(options.tags != null ? { tags: options.tags } : {}),
      ...(options.exposure != null ? { exposure: options.exposure } : {}),
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_TOOL_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
