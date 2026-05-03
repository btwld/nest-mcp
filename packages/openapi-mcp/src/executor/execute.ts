import { McpUpstreamError, ToolExecutionError } from '@nest-mcp/common';
import type { NormalizedRequest } from '../interfaces/openapi-mcp-options.interface';

export interface ExecuteResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Issue an HTTP request and return a structured result. Non-2xx responses
 * become `McpUpstreamError`. Network/timeout failures become `ToolExecutionError`.
 */
export async function execute(
  request: NormalizedRequest,
  toolName: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.body === undefined || request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : JSON.stringify(request.body),
      signal: controller.signal,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const contentType = responseHeaders['content-type'] ?? '';
    let body: unknown;
    try {
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch {
      body = '';
    }

    if (!response.ok) {
      throw new McpUpstreamError(
        toolName,
        `received ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`,
      );
    }

    return { status: response.status, body, headers: responseHeaders };
  } catch (err) {
    if (err instanceof McpUpstreamError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new ToolExecutionError(toolName, `timed out after ${timeoutMs}ms`, err as Error);
    }
    throw new ToolExecutionError(toolName, (err as Error).message, err as Error);
  } finally {
    clearTimeout(timer);
  }
}
