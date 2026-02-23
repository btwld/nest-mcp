import { MCP_CIRCUIT_BREAKER_METADATA } from '@btwld/mcp-common';
import type { CircuitBreakerConfig } from '@btwld/mcp-common';

export function CircuitBreaker(config: CircuitBreakerConfig): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MCP_CIRCUIT_BREAKER_METADATA, config, target, propertyKey);
    return descriptor;
  };
}
