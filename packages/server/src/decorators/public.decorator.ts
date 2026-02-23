import { MCP_PUBLIC_METADATA } from '@btwld/mcp-common';

export function Public(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_PUBLIC_METADATA, true, target, propertyKey);
    return descriptor;
  };
}
