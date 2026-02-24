import type { McpHttpAdapter } from '@btwld/mcp-common';

export class FastifyAdapter implements McpHttpAdapter {
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
    (response as { header: (name: string, value: string) => void }).header(name, value);
  }

  sendResponse(response: unknown, statusCode: number, body?: unknown): void {
    const res = response as {
      code: (code: number) => { send: (body?: unknown) => void };
    };
    if (body !== undefined) {
      res.code(statusCode).send(body);
    } else {
      res.code(statusCode).send();
    }
  }

  sendSseEvent(response: unknown, event: string, data: string, id?: string): void {
    const raw = (response as { raw: { write: (chunk: string) => void } }).raw;
    if (id) raw.write(`id: ${id}\n`);
    raw.write(`event: ${event}\n`);
    raw.write(`data: ${data}\n\n`);
  }

  setupSse(response: unknown): void {
    const raw = (
      response as { raw: { writeHead: (status: number, headers: Record<string, string>) => void } }
    ).raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }

  closeSse(response: unknown): void {
    const raw = (response as { raw: { end: () => void } }).raw;
    raw.end();
  }

  onClose(response: unknown, callback: () => void): void {
    const raw = (response as { raw: { on: (event: string, cb: () => void) => void } }).raw;
    raw.on('close', callback);
  }
}
