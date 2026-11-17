import 'reflect-metadata';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpTransportType } from '@nest-mcp/common';
import type { McpExecutionContext } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, McpToolBuilder, Prompt, Tool } from '../../src';
import { connectStreamable, createMcpApp, waitFor } from './helpers';
import type { E2eApp } from './helpers';

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

@Injectable()
class PromptsOnly {
  @Prompt({ name: 'hello', description: 'A prompt without parameters' })
  hello() {
    return { messages: [{ role: 'user', content: { type: 'text', text: 'Hello!' } }] };
  }

  @Prompt({
    name: 'greet',
    description: 'A prompt with parameters',
    parameters: z.object({ name: z.string() }),
  })
  greet(args: { name: string }) {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Hello ${args.name}!` } }] };
  }
}

describe('server without tools', () => {
  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'prompts-only',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      ],
      providers: [PromptsOnly],
    });
    client = await connectStreamable(server.baseUrl);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('connects and lists prompts when no tools are registered', async () => {
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['greet', 'hello']);
  });

  it('serves a prompt that declares no parameters', async () => {
    const result = await client.getPrompt({ name: 'hello' });
    expect(result.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Hello!' } }]);
  });

  it('serves a prompt with parameters', async () => {
    const result = await client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    expect(result.messages[0]?.content).toEqual({ type: 'text', text: 'Hello Ada!' });
  });

  it('answers completion for an unknown prompt with Invalid params', async () => {
    await expect(
      client.complete({
        ref: { type: 'ref/prompt', name: 'missing' },
        argument: { name: 'x', value: '' },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe('tools capability that starts empty', () => {
  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'empty-tools',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          capabilities: { tools: { listChanged: true } },
        }),
      ],
    });
    client = await connectStreamable(server.baseUrl);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists no tools, then serves a tool registered at runtime', async () => {
    expect((await client.listTools()).tools).toEqual([]);

    server.app.get(McpToolBuilder).register({
      name: 'late-tool',
      description: 'Registered after the session started',
      parameters: z.object({ value: z.string() }),
      handler: async (args) => `late:${String(args.value)}`,
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['late-tool']);

    const result = await client.callTool({ name: 'late-tool', arguments: { value: 'x' } });
    expect(result.content).toEqual([{ type: 'text', text: 'late:x' }]);
  });
});

@Injectable()
class ConformanceTools {
  aborted = false;

  @Tool({
    name: 'paged',
    description: 'A tool with a defaulted parameter',
    parameters: z.object({ query: z.string(), limit: z.number().default(10) }),
  })
  paged(args: { query: string; limit: number }) {
    return `${args.query}:${args.limit}`;
  }

  @Tool({ name: 'wait', description: 'Waits until cancelled', parameters: z.object({}) })
  async wait(_args: unknown, ctx: McpExecutionContext) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      ctx.signal?.addEventListener('abort', () => {
        this.aborted = true;
        clearTimeout(timer);
        resolve();
      });
    });
    return 'done';
  }

  @Tool({ name: 'ask-name', description: 'Asks the user for a name', parameters: z.object({}) })
  async askName(_args: unknown, ctx: McpExecutionContext) {
    const answer = await ctx.elicit?.({
      message: 'What is your name?',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    return `name:${String(answer?.content?.name)}`;
  }
}

describe('protocol conformance', () => {
  let server: E2eApp;
  const closedSessions: string[] = [];

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'conformance',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: {
            streamableHttp: {
              onsessionclosed: (sessionId: string) => {
                closedSessions.push(sessionId);
              },
            },
          },
        }),
      ],
      providers: [ConformanceTools],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('does not list a defaulted parameter as required', async () => {
    const client = await connectStreamable(server.baseUrl);
    try {
      const { tools } = await client.listTools();
      const paged = tools.find((t) => t.name === 'paged');
      expect(paged?.inputSchema.required).toEqual(['query']);

      const result = await client.callTool({ name: 'paged', arguments: { query: 'q' } });
      expect(result.content).toEqual([{ type: 'text', text: 'q:10' }]);
    } finally {
      await client.close();
    }
  });

  it('rejects an invalid pagination cursor with Invalid params', async () => {
    const client = await connectStreamable(server.baseUrl);
    try {
      await expect(client.listTools({ cursor: '!!not-a-cursor!!' })).rejects.toMatchObject({
        code: -32602,
      });
    } finally {
      await client.close();
    }
  });

  it('aborts the handler signal when the client cancels the request', async () => {
    const client = await connectStreamable(server.baseUrl);
    const tools = server.app.get(ConformanceTools);
    tools.aborted = false;
    try {
      const controller = new AbortController();
      const call = client.callTool({ name: 'wait', arguments: {} }, undefined, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 150);
      await expect(call).rejects.toThrow();
      await waitFor(() => tools.aborted);
    } finally {
      await client.close();
    }
  });

  it('delivers elicitation requests made from a tool call', async () => {
    const client = new Client(
      { name: 'e2e-elicit', version: '1.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'accept',
      content: { name: 'Ada' },
    }));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`)));
    try {
      const result = await client.callTool({ name: 'ask-name', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: 'name:Ada' }]);
    } finally {
      await client.close();
    }
  });

  it('answers a request for an unknown session with 404', async () => {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-session-id': 'no-such-session' },
      body: rpc('tools/list'),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
  });

  it('answers GET and DELETE without a session id with 400', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${server.baseUrl}/mcp`, {
        method,
        headers: { accept: 'text/event-stream' },
      });
      expect(response.status).toBe(400);
      expect((await response.json()).jsonrpc).toBe('2.0');
    }
  });

  it('terminates a session on DELETE, notifies onsessionclosed, then answers 404', async () => {
    const client = new Client({ name: 'e2e-delete', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`));
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();

    await transport.terminateSession();
    await waitFor(() => closedSessions.includes(String(sessionId)));

    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-session-id': String(sessionId) },
      body: rpc('tools/list'),
    });
    expect(response.status).toBe(404);
    await client.close().catch(() => {});
  });
});
