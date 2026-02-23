import { MCP_RETRY_METADATA } from '@btwld/mcp-common';
import type { RetryConfig } from '@btwld/mcp-common';

export function Retry(config: RetryConfig): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_RETRY_METADATA, config, target, propertyKey);
    return descriptor;
  };
}
