import { MCP_RESOURCE_METADATA } from '@nest-mcp/common';
import type { ResourceMetadata, ResourceOptions } from '@nest-mcp/common';

export function Resource(options: ResourceOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ResourceMetadata = {
      uri: options.uri,
      name: options.name || String(propertyKey),
      ...(options.title != null ? { title: options.title } : {}),
      description: options.description,
      mimeType: options.mimeType,
      ...(options.icons != null ? { icons: options.icons } : {}),
      ...('_meta' in options && options._meta != null ? { _meta: options._meta } : {}),
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_RESOURCE_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
