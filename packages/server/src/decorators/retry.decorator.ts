import { MCP_RETRY_METADATA } from '@nest-mcp/common';
import type { RetryConfig } from '@nest-mcp/common';

export function Retry(config: RetryConfig): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_RETRY_METADATA, config, target, propertyKey);
    return descriptor;
  };
}
