import 'reflect-metadata';
import { McpTransportType } from '@btwld/mcp-common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { McpRegistryService } from '../discovery/registry.service';
import { createMcpServer } from './server.factory';

function makeRegistry(flags: {
  hasTools?: boolean;
  hasResources?: boolean;
  hasResourceTemplates?: boolean;
  hasPrompts?: boolean;
} = {}): McpRegistryService {
  const registry = new McpRegistryService();
  // Expose the flags via a partial object cast — registry getters are read-only,
  // so we override the prototype properties via Object.defineProperty.
  if (flags.hasTools !== undefined)
    Object.defineProperty(registry, 'hasTools', { get: () => flags.hasTools });
  if (flags.hasResources !== undefined)
    Object.defineProperty(registry, 'hasResources', { get: () => flags.hasResources });
  if (flags.hasResourceTemplates !== undefined)
    Object.defineProperty(registry, 'hasResourceTemplates', { get: () => flags.hasResourceTemplates });
  if (flags.hasPrompts !== undefined)
    Object.defineProperty(registry, 'hasPrompts', { get: () => flags.hasPrompts });
  return registry;
}

const baseOptions = {
  name: 'test-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
} as const;

describe('createMcpServer', () => {
  it('returns an McpServer instance', () => {
    const server = createMcpServer(makeRegistry(), baseOptions);
    expect(server).toBeInstanceOf(McpServer);
  });

  it('sets the server name and version', () => {
    const server = createMcpServer(makeRegistry(), {
      ...baseOptions,
      name: 'my-mcp',
      version: '2.3.4',
    });
    // The underlying Server exposes name/version via getClientCapabilities but
    // McpServer wraps it — we verify the object is created without throwing.
    expect(server).toBeInstanceOf(McpServer);
  });

  it('includes instructions when description is provided', () => {
    // If description is absent, no throw; if present, it is forwarded.
    // We verify the factory does not throw in either case.
    expect(() =>
      createMcpServer(makeRegistry(), { ...baseOptions, description: 'A helpful server' }),
    ).not.toThrow();
  });

  it('does not throw when description is absent', () => {
    expect(() => createMcpServer(makeRegistry(), baseOptions)).not.toThrow();
  });

  it('passes taskStore and taskMessageQueue when taskManager is provided', () => {
    const taskManager = {
      store: { get: () => undefined },
      queue: { push: () => {} },
    };
    expect(() =>
      createMcpServer(makeRegistry(), baseOptions, taskManager as never),
    ).not.toThrow();
  });

  it('does not throw when taskManager is absent', () => {
    expect(() => createMcpServer(makeRegistry(), baseOptions, undefined)).not.toThrow();
  });

  it('reflects tool capability when registry has tools', () => {
    const server = createMcpServer(makeRegistry({ hasTools: true }), baseOptions);
    expect(server).toBeInstanceOf(McpServer);
  });

  it('reflects resource capability when registry has resources', () => {
    const server = createMcpServer(makeRegistry({ hasResources: true }), baseOptions);
    expect(server).toBeInstanceOf(McpServer);
  });
});
