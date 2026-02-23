import { MCP_SCOPES_METADATA } from '@btwld/mcp-common';

export function Scopes(scopes: string[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_SCOPES_METADATA, scopes, target, propertyKey);
    return descriptor;
  };
}
