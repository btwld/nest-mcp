import { MCP_RESOURCE_TEMPLATE_METADATA } from '@btwld/mcp-common';
import type { ResourceTemplateMetadata, ResourceTemplateOptions } from '@btwld/mcp-common';

export function ResourceTemplate(options: ResourceTemplateOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ResourceTemplateMetadata = {
      uriTemplate: options.uriTemplate,
      name: options.name || String(propertyKey),
      ...(options.title != null ? { title: options.title } : {}),
      description: options.description,
      mimeType: options.mimeType,
      ...(options.icons != null ? { icons: options.icons } : {}),
      ...('_meta' in options && options._meta != null ? { _meta: options._meta } : {}),
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_RESOURCE_TEMPLATE_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
