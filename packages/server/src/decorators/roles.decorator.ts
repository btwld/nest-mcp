import { MCP_ROLES_METADATA } from '@nest-mcp/common';

export function Roles(roles: string[]): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_ROLES_METADATA, roles, target, propertyKey);
    return descriptor;
  };
}
