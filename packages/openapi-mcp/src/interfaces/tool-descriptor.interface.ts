import type { z } from 'zod';
import type { NormalizedRequest, OperationContext } from './openapi-mcp-options.interface';

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface ParameterDescriptor {
  name: string;
  in: ParameterLocation;
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface BodyDescriptor {
  /** When true, the body is a wrapped freeform JSON object stored under `body`. */
  wrapped: boolean;
  /** When true, the body is a JSON array; tool input takes the array under `items`. */
  arrayBody: boolean;
  required: boolean;
  schema: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  zodSchema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  context: OperationContext;
  parameters: ParameterDescriptor[];
  body?: BodyDescriptor;
  /** Compiled HTTP request shape for the upstream call (path with `{token}` placeholders). */
  request: {
    method: string;
    pathTemplate: string;
  };
}

export interface ExecuteContext {
  inboundHeaders?: Record<string, string>;
}

export type ExecuteFn = (
  args: Record<string, unknown>,
  ctx?: ExecuteContext,
) => Promise<{ status: number; body: unknown; headers: Record<string, string> }>;

export interface BuiltTool {
  descriptor: ToolDescriptor;
  execute: ExecuteFn;
  /** The original normalized request before auth is applied (for diagnostics). */
  buildRequest: (args: Record<string, unknown>) => NormalizedRequest;
}
