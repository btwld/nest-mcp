import { MCP_RATE_LIMIT_METADATA } from '@btwld/mcp-common';
import type { RateLimitConfig } from '@btwld/mcp-common';

export function RateLimit(config: RateLimitConfig): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_RATE_LIMIT_METADATA, config, target, propertyKey);
    return descriptor;
  };
}
