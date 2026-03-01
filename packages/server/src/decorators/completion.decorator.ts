import { MCP_COMPLETION_METADATA } from '@nest-mcp/common';

export interface CompletionOptions {
  /** Which ref this completer handles: 'ref/prompt' or 'ref/resource' */
  refType: 'ref/prompt' | 'ref/resource';
  /** The prompt name or resource template URI this completer is for */
  refName: string;
}

export interface CompletionMetadata {
  refType: 'ref/prompt' | 'ref/resource';
  refName: string;
  methodName: string;
  target: abstract new (...args: unknown[]) => unknown;
}

export function Completion(options: CompletionOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const metadata: CompletionMetadata = {
      refType: options.refType,
      refName: options.refName,
      methodName: String(propertyKey),
      target: target.constructor as abstract new (...args: unknown[]) => unknown,
    };

    Reflect.defineMetadata(MCP_COMPLETION_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}
