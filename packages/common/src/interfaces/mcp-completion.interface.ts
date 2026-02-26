export interface CompletionRequest {
  ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };
  argument: { name: string; value: string };
  context?: { arguments?: Record<string, string> };
}

export interface CompletionResult {
  values: string[];
  hasMore?: boolean;
  total?: number;
}

export type CompletionHandler = (
  request: CompletionRequest,
) => CompletionResult | Promise<CompletionResult>;
