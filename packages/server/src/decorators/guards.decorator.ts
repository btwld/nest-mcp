import { MCP_GUARDS_METADATA } from '@btwld/mcp-common';

export function Guards(guards: Function[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_GUARDS_METADATA, guards, target, propertyKey);
    return descriptor;
  };
}
