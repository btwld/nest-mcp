import { MCP_RESOURCE_METADATA } from '@btwld/mcp-common';
import type { ResourceMetadata, ResourceOptions } from '@btwld/mcp-common';

export function Resource(options: ResourceOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ResourceMetadata = {
      uri: options.uri,
      name: options.name || String(propertyKey),
      description: options.description,
      mimeType: options.mimeType,
      methodName: String(propertyKey),
      target: target.constructor,
    };

    Reflect.defineMetadata(MCP_RESOURCE_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
