import { MCP_TIMEOUT_METADATA } from '@btwld/mcp-common';

export function Timeout(ms: number): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_TIMEOUT_METADATA, ms, target, propertyKey);
    return descriptor;
  };
}
