import type { McpHttpAdapter } from '@btwld/mcp-common';

export class ExpressAdapter implements McpHttpAdapter {
  getRequestMethod(request: any): string {
    return request.method;
  }

  getRequestUrl(request: any): string {
    return request.url;
  }

  getRequestHeaders(request: any): Record<string, string | string[]> {
    return request.headers;
  }

  getRequestBody(request: any): unknown {
    return request.body;
  }

  getRequestQuery(request: any): Record<string, string> {
    return request.query;
  }

  setResponseHeader(response: any, name: string, value: string): void {
    response.setHeader(name, value);
  }

  sendResponse(response: any, statusCode: number, body?: unknown): void {
    if (body !== undefined) {
      response.status(statusCode).json(body);
    } else {
      response.status(statusCode).end();
    }
  }

  sendSseEvent(response: any, event: string, data: string, id?: string): void {
    if (id) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\n`);
    response.write(`data: ${data}\n\n`);
    if (response.flush) response.flush();
  }

  setupSse(response: any): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }

  closeSse(response: any): void {
    response.end();
  }

  onClose(response: any, callback: () => void): void {
    response.on('close', callback);
  }
}
