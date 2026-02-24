import type { McpGuard } from '@btwld/mcp-common';
import { MCP_GUARDS_METADATA } from '@btwld/mcp-common';

export function Guards(guards: Array<new (...args: unknown[]) => McpGuard>): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_GUARDS_METADATA, guards, target, propertyKey);
    return descriptor;
  };
}
