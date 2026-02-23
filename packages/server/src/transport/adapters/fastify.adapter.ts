import type { McpHttpAdapter } from '@btwld/mcp-common';

export class FastifyAdapter implements McpHttpAdapter {
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
    response.header(name, value);
  }

  sendResponse(response: any, statusCode: number, body?: unknown): void {
    if (body !== undefined) {
      response.code(statusCode).send(body);
    } else {
      response.code(statusCode).send();
    }
  }

  sendSseEvent(response: any, event: string, data: string, id?: string): void {
    const raw = response.raw;
    if (id) raw.write(`id: ${id}\n`);
    raw.write(`event: ${event}\n`);
    raw.write(`data: ${data}\n\n`);
  }

  setupSse(response: any): void {
    const raw = response.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }

  closeSse(response: any): void {
    const raw = response.raw;
    raw.end();
  }

  onClose(response: any, callback: () => void): void {
    const raw = response.raw;
    raw.on('close', callback);
  }
}
