import { MCP_RESOURCE_TEMPLATE_METADATA } from '@btwld/mcp-common';
import type { ResourceTemplateOptions, ResourceTemplateMetadata } from '@btwld/mcp-common';

export function ResourceTemplate(options: ResourceTemplateOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: ResourceTemplateMetadata = {
      uriTemplate: options.uriTemplate,
      name: options.name || String(propertyKey),
      description: options.description,
      mimeType: options.mimeType,
      methodName: String(propertyKey),
      target: target.constructor,
    };

    Reflect.defineMetadata(MCP_RESOURCE_TEMPLATE_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
