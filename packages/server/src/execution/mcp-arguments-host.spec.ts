import { McpError } from '@nest-mcp/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { mockMcpContext } from '../testing/mock-context';
import { MCP_CONTEXT_TYPE, McpArgumentsHost, runMcpCapabilityCall } from './mcp-arguments-host';

function hostOf(args: unknown[], type: string = MCP_CONTEXT_TYPE) {
  const host = new ExecutionContextHost(args);
  host.setType(type);
  return host;
}

describe('McpArgumentsHost', () => {
  const ctx = mockMcpContext();

  it('exposes the tool name, arguments and execution context', () => {
    const args = { city: 'Lisbon' };

    const mcp = runMcpCapabilityCall({ kind: 'tool', name: 'weather' }, () =>
      McpArgumentsHost.create(hostOf([args, ctx])),
    );

    expect(mcp.getKind()).toBe('tool');
    expect(mcp.getName()).toBe('weather');
    expect(mcp.getArgs()).toBe(args);
    expect(mcp.getContext()).toBe(ctx);
  });

  it('exposes prompt arguments the same way', () => {
    const args = { topic: 'release' };

    const mcp = runMcpCapabilityCall({ kind: 'prompt', name: 'summarize' }, () =>
      McpArgumentsHost.create(hostOf([args, ctx])),
    );

    expect(mcp.getKind()).toBe('prompt');
    expect(mcp.getName()).toBe('summarize');
    expect(mcp.getArgs()).toBe(args);
    expect(mcp.getContext()).toBe(ctx);
  });

  it('reports the requested URI and no variables for a fixed-URI resource', () => {
    const uri = 'config://app';

    const mcp = runMcpCapabilityCall({ kind: 'resource', name: uri }, () =>
      McpArgumentsHost.create(hostOf([new URL(uri), ctx])),
    );

    expect(mcp.getKind()).toBe('resource');
    expect(mcp.getName()).toBe(uri);
    expect(mcp.getArgs()).toEqual({});
    expect(mcp.getContext()).toBe(ctx);
  });

  it('reports the URI template variables for a templated resource', () => {
    const uri = 'users://42';
    const variables = { id: '42' };

    const mcp = runMcpCapabilityCall({ kind: 'resource', name: uri }, () =>
      McpArgumentsHost.create(hostOf([new URL(uri), variables, ctx])),
    );

    expect(mcp.getName()).toBe(uri);
    expect(mcp.getArgs()).toBe(variables);
    expect(mcp.getContext()).toBe(ctx);
  });

  it('keeps nested capability calls apart', async () => {
    const seen: string[] = [];

    await runMcpCapabilityCall({ kind: 'tool', name: 'outer' }, async () => {
      await runMcpCapabilityCall({ kind: 'tool', name: 'inner' }, async () => {
        await Promise.resolve();
        seen.push(McpArgumentsHost.create(hostOf([{}, ctx])).getName());
      });
      seen.push(McpArgumentsHost.create(hostOf([{}, ctx])).getName());
    });

    expect(seen).toEqual(['inner', 'outer']);
  });

  it('keeps concurrent capability calls apart', async () => {
    const nameAfterTick = (name: string) =>
      runMcpCapabilityCall({ kind: 'tool', name }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return McpArgumentsHost.create(hostOf([{}, ctx])).getName();
      });

    await expect(Promise.all([nameAfterTick('a'), nameAfterTick('b')])).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  it('rejects a context of another type', () => {
    expect(() =>
      runMcpCapabilityCall({ kind: 'tool', name: 'weather' }, () =>
        McpArgumentsHost.create(hostOf([{}, ctx], 'http')),
      ),
    ).toThrow(McpError);
    expect(() => McpArgumentsHost.create(hostOf([{}, ctx], 'http'))).toThrow(
      "requires an 'mcp' context but received 'http'",
    );
  });

  it('rejects use outside of a capability call', () => {
    expect(() => McpArgumentsHost.create(hostOf([{}, ctx]))).toThrow(
      'outside of an MCP capability call',
    );
  });
});
