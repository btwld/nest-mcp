import { MCP_MIDDLEWARE_METADATA } from '@nest-mcp/common';
import type { McpMiddleware } from '@nest-mcp/common';

export function UseMiddleware(...middleware: McpMiddleware[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_MIDDLEWARE_METADATA, middleware, target, propertyKey);
    return descriptor;
  };
}
