export interface McpHttpAdapter {
  getRequestMethod(request: unknown): string;
  getRequestUrl(request: unknown): string;
  getRequestHeaders(request: unknown): Record<string, string | string[]>;
  getRequestBody(request: unknown): unknown;
  getRequestQuery(request: unknown): Record<string, string>;
  setResponseHeader(response: unknown, name: string, value: string): void;
  sendResponse(response: unknown, statusCode: number, body?: unknown): void;
  sendSseEvent(response: unknown, event: string, data: string, id?: string): void;
  setupSse(response: unknown): void;
  closeSse(response: unknown): void;
  onClose(response: unknown, callback: () => void): void;
}

export type HttpAdapterType = 'express' | 'fastify';
