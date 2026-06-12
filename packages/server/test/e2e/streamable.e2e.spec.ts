import 'reflect-metadata';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpExecutionContext } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Prompt, Public, Resource, Scopes, Tool } from '../../src';
import { connectStreamable, createMcpApp, waitFor } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class KitchenSink {
  @Tool({ name: 'greet', description: 'Greet someone', parameters: z.object({ name: z.string() }) })
  greet({ name }: { name: string }) {
    return `hello ${name}`;
  }

  @Tool({
    name: 'add',
    description: 'Add two numbers',
    parameters: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ sum: z.number() }),
  })
  add({ a, b }: { a: number; b: number }) {
    return { sum: a + b };
  }

  @Tool({ name: 'long-task', description: 'Reports progress', parameters: z.object({}) })
  async longTask(_args: Record<string, never>, ctx: McpExecutionContext) {
    await ctx.reportProgress({ progress: 50, total: 100 });
    await ctx.reportProgress({ progress: 100, total: 100 });
    return 'done';
  }

  @Tool({ name: 'chatty', description: 'Emits an info log', parameters: z.object({}) })
  chatty(_args: Record<string, never>, ctx: McpExecutionContext) {
    ctx.log.info('hello from chatty');
    return 'ok';
  }

  @Tool({ name: 'grumpy', description: 'Emits an error log', parameters: z.object({}) })
  grumpy(_args: Record<string, never>, ctx: McpExecutionContext) {
    ctx.log.error('boom from grumpy');
    return 'ok';
  }

  @Prompt({
    name: 'greeting',
    description: 'Greeting prompt',
    parameters: z.object({ tone: z.enum(['formal', 'casual']) }),
  })
  greeting({ tone }: { tone: string }) {
    return { messages: [{ role: 'user', content: { type: 'text', text: `be ${tone}` } }] };
  }

  @Resource({
    uri: 'app://config',
    name: 'config',
    description: 'App config',
    mimeType: 'application/json',
  })
  config() {
    return JSON.stringify({ ok: true });
  }
}

describe('streamable HTTP e2e', () => {
  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'e2e-server',
          version: '1.0.0',
          description: 'Server used by the e2e suite',
          instructions: 'Always greet before adding numbers.',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      ],
      providers: [KitchenSink],
    });
    client = await connectStreamable(server.baseUrl);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('returns the dedicated instructions on initialize', () => {
    expect(client.getInstructions()).toBe('Always greet before adding numbers.');
  });

  it('reports server info from module options', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'e2e-server', version: '1.0.0' });
  });

  it('lists decorated tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['greet', 'add', 'long-task', 'chatty', 'grumpy']),
    );
  });

  it('calls a tool and returns text content', async () => {
    const result = await client.callTool({ name: 'greet', arguments: { name: 'ada' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hello ada' }]);
  });

  it('validates output schema and returns structuredContent', async () => {
    const result = await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } });
    expect(result.structuredContent).toEqual({ sum: 3 });
  });

  it('surfaces invalid params as an isError tool result, not a protocol error', async () => {
    const result = await client.callTool({ name: 'greet', arguments: { name: 42 } });
    expect(result.isError).toBe(true);
  });

  it('streams progress notifications for the calling request', async () => {
    const progress: Array<{ progress: number }> = [];
    await client.callTool({ name: 'long-task', arguments: {} }, undefined, {
      onprogress: (p) => progress.push(p),
    });
    await waitFor(() => progress.length >= 2);
    expect(progress[0]).toMatchObject({ progress: 50, total: 100 });
    expect(progress[1]).toMatchObject({ progress: 100, total: 100 });
  });

  it('delivers ctx.log output as notifications/message', async () => {
    const messages: Array<{ level: string }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      messages.push(n.params as { level: string });
    });

    await client.callTool({ name: 'chatty', arguments: {} });
    await waitFor(() => messages.some((m) => m.level === 'info'));
  });

  it('honors logging/setLevel: messages below the level are suppressed', async () => {
    const messages: Array<{ level: string }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      messages.push(n.params as { level: string });
    });

    await client.setLoggingLevel('error');
    await client.callTool({ name: 'chatty', arguments: {} });
    await client.callTool({ name: 'grumpy', arguments: {} });
    await waitFor(() => messages.some((m) => m.level === 'error'));

    expect(messages.some((m) => m.level === 'info')).toBe(false);
  });

  it('serves prompts with validated arguments', async () => {
    const result = await client.getPrompt({ name: 'greeting', arguments: { tone: 'formal' } });
    expect(result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'be formal' } },
    ]);
  });

  it('completes enum prompt arguments by prefix (default completion)', async () => {
    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'greeting' },
      argument: { name: 'tone', value: 'f' },
    });
    expect(result.completion.values).toEqual(['formal']);
  });

  it('reads resources', async () => {
    const result = await client.readResource({ uri: 'app://config' });
    expect(result.contents[0]).toMatchObject({ uri: 'app://config' });
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual({ ok: true });
  });
});

describe('streamable HTTP e2e — securitySchemes advertisement', () => {
  @Injectable()
  class GatedTools {
    @Tool({ name: 'open-tool', description: 'Public tool', parameters: z.object({}) })
    @Public()
    openTool() {
      return 'open';
    }

    @Tool({ name: 'scoped-tool', description: 'Needs scopes', parameters: z.object({}) })
    @Scopes(['read:data'])
    scopedTool() {
      return 'scoped';
    }
  }

  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'gated-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          advertiseSecuritySchemes: true,
        }),
      ],
      providers: [GatedTools],
    });
    client = await connectStreamable(server.baseUrl);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('advertises noauth for @Public tools and oauth2+scopes for @Scopes tools', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get('open-tool')?._meta?.securitySchemes).toEqual([{ type: 'noauth' }]);
    expect(byName.get('scoped-tool')?._meta?.securitySchemes).toEqual([
      { type: 'oauth2', scopes: ['read:data'] },
    ]);
  });
});
