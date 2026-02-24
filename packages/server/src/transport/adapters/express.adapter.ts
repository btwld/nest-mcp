import type { McpHttpAdapter } from '@btwld/mcp-common';

export class ExpressAdapter implements McpHttpAdapter {
  getRequestMethod(request: unknown): string {
    return (request as { method: string }).method;
  }

  getRequestUrl(request: unknown): string {
    return (request as { url: string }).url;
  }

  getRequestHeaders(request: unknown): Record<string, string | string[]> {
    return (request as { headers: Record<string, string | string[]> }).headers;
  }

  getRequestBody(request: unknown): unknown {
    return (request as { body: unknown }).body;
  }

  getRequestQuery(request: unknown): Record<string, string> {
    return (request as { query: Record<string, string> }).query;
  }

  setResponseHeader(response: unknown, name: string, value: string): void {
    (response as { setHeader: (name: string, value: string) => void }).setHeader(name, value);
  }

  sendResponse(response: unknown, statusCode: number, body?: unknown): void {
    const res = response as {
      status: (code: number) => { json: (body: unknown) => void; end: () => void };
    };
    if (body !== undefined) {
      res.status(statusCode).json(body);
    } else {
      res.status(statusCode).end();
    }
  }

  sendSseEvent(response: unknown, event: string, data: string, id?: string): void {
    const res = response as { write: (chunk: string) => void; flush?: () => void };
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
    if (res.flush) res.flush();
  }

  setupSse(response: unknown): void {
    (
      response as { writeHead: (status: number, headers: Record<string, string>) => void }
    ).writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }

  closeSse(response: unknown): void {
    (response as { end: () => void }).end();
  }

  onClose(response: unknown, callback: () => void): void {
    (response as { on: (event: string, cb: () => void) => void }).on('close', callback);
  }
}
