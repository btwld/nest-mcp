import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { McpTransportType } from '@nest-mcp/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock IO-creating dependencies before importing the service
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../server/server.factory', () => ({
  createMcpServer: vi.fn(),
}));

vi.mock('../register-handlers', () => ({
  registerHandlers: vi.fn(),
  registerToolOnServer: vi.fn(),
  registerResourceOnServer: vi.fn(),
  registerPromptOnServer: vi.fn(),
  registerResourceTemplateOnServer: vi.fn(),
}));

import { createMcpServer } from '../../server/server.factory';
import {
  registerPromptOnServer,
  registerResourceOnServer,
  registerResourceTemplateOnServer,
  registerToolOnServer,
} from '../register-handlers';
import { StdioService } from './stdio.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRegistry() {
  return { events: new EventEmitter() };
}

function makeMockHandle() {
  return { remove: vi.fn() };
}

function makeMockServer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeService(opts: { subscriptionManager?: object; taskManager?: object } = {}) {
  const registry = makeRegistry();
  const options = { name: 'test', version: '1.0', transport: McpTransportType.STDIO };
  const ctx = { sessionId: 'stdio', transport: McpTransportType.STDIO };
  const contextFactory = { createContext: vi.fn().mockReturnValue(ctx) };

  const service = new StdioService(
    options as never,
    registry as never,
    {} as never,
    {} as never,
    contextFactory as never,
    opts.subscriptionManager as never,
    opts.taskManager as never,
  );

  return { service, registry, ctx };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StdioService', () => {
  let mockServer: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mockServer = makeMockServer();
    vi.mocked(createMcpServer).mockReturnValue(mockServer as never);
    vi.mocked(registerToolOnServer).mockReturnValue(makeMockHandle() as never);
    vi.mocked(registerResourceOnServer).mockReturnValue(makeMockHandle() as never);
    vi.mocked(registerPromptOnServer).mockReturnValue(makeMockHandle() as never);
    vi.mocked(registerResourceTemplateOnServer).mockReturnValue(makeMockHandle() as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('subscribes to all 8 registry event types', () => {
      const { registry } = makeService();
      const events = registry.events.eventNames();
      expect(events).toContain('tool.registered');
      expect(events).toContain('tool.unregistered');
      expect(events).toContain('resource.registered');
      expect(events).toContain('resource.unregistered');
      expect(events).toContain('prompt.registered');
      expect(events).toContain('prompt.unregistered');
      expect(events).toContain('resourceTemplate.registered');
      expect(events).toContain('resourceTemplate.unregistered');
    });
  });

  // ─── Before start: events are no-ops ────────────────────────────────────

  describe('before start()', () => {
    it('ignores tool.registered events when server is not yet connected', () => {
      const { registry } = makeService();
      expect(() =>
        registry.events.emit('tool.registered', { name: 'my-tool' }),
      ).not.toThrow();
      expect(registerToolOnServer).not.toHaveBeenCalled();
    });

    it('ignores resource.registered events when server is not yet connected', () => {
      const { registry } = makeService();
      expect(() =>
        registry.events.emit('resource.registered', { uri: 'file://test' }),
      ).not.toThrow();
      expect(registerResourceOnServer).not.toHaveBeenCalled();
    });

    it('ignores prompt.registered events when server is not yet connected', () => {
      const { registry } = makeService();
      expect(() =>
        registry.events.emit('prompt.registered', { name: 'greet' }),
      ).not.toThrow();
      expect(registerPromptOnServer).not.toHaveBeenCalled();
    });

    it('ignores resourceTemplate.registered events when server is not yet connected', () => {
      const { registry } = makeService();
      expect(() =>
        registry.events.emit('resourceTemplate.registered', { uriTemplate: 'docs://{id}' }),
      ).not.toThrow();
      expect(registerResourceTemplateOnServer).not.toHaveBeenCalled();
    });
  });

  // ─── start() ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('creates the MCP server and connects it', async () => {
      const { service } = makeService();
      await service.start();
      expect(createMcpServer).toHaveBeenCalled();
      expect(mockServer.connect).toHaveBeenCalled();
    });
  });

  // ─── Dynamic registration after start ───────────────────────────────────

  describe('dynamic registration (after start)', () => {
    it('registers a tool and stores its sdk handle', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerToolOnServer).mockReturnValue(handle as never);

      const tool = { name: 'new-tool' };
      registry.events.emit('tool.registered', tool);

      expect(registerToolOnServer).toHaveBeenCalledWith(
        mockServer,
        tool,
        expect.anything(),
        expect.anything(),
      );
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('tool:new-tool')).toBe(true);
    });

    it('registers a resource and stores its sdk handle', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerResourceOnServer).mockReturnValue(handle as never);

      const resource = { uri: 'file://data' };
      registry.events.emit('resource.registered', resource);

      expect(registerResourceOnServer).toHaveBeenCalled();
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('resource:file://data')).toBe(true);
    });

    it('registers a prompt and stores its sdk handle', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerPromptOnServer).mockReturnValue(handle as never);

      const prompt = { name: 'my-prompt' };
      registry.events.emit('prompt.registered', prompt);

      expect(registerPromptOnServer).toHaveBeenCalled();
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('prompt:my-prompt')).toBe(true);
    });

    it('registers a resource template and stores its sdk handle', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerResourceTemplateOnServer).mockReturnValue(handle as never);

      const template = { uriTemplate: 'file://{id}' };
      registry.events.emit('resourceTemplate.registered', template);

      expect(registerResourceTemplateOnServer).toHaveBeenCalled();
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('resourceTemplate:file://{id}')).toBe(true);
    });
  });

  // ─── Dynamic unregistration ──────────────────────────────────────────────

  describe('dynamic unregistration (after start)', () => {
    it('calls handle.remove() and deletes the key on tool.unregistered', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerToolOnServer).mockReturnValue(handle as never);
      registry.events.emit('tool.registered', { name: 'my-tool' });

      registry.events.emit('tool.unregistered', 'my-tool');

      expect(handle.remove).toHaveBeenCalled();
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('tool:my-tool')).toBe(false);
    });

    it('calls handle.remove() on resource.unregistered', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerResourceOnServer).mockReturnValue(handle as never);
      registry.events.emit('resource.registered', { uri: 'file://doc' });

      registry.events.emit('resource.unregistered', 'file://doc');

      expect(handle.remove).toHaveBeenCalled();
      const handles = (service as unknown as { sdkHandles: Map<string, unknown> }).sdkHandles;
      expect(handles.has('resource:file://doc')).toBe(false);
    });

    it('calls handle.remove() on prompt.unregistered', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerPromptOnServer).mockReturnValue(handle as never);
      registry.events.emit('prompt.registered', { name: 'greet' });

      registry.events.emit('prompt.unregistered', 'greet');

      expect(handle.remove).toHaveBeenCalled();
    });

    it('calls handle.remove() on resourceTemplate.unregistered', async () => {
      const { service, registry } = makeService();
      await service.start();

      const handle = makeMockHandle();
      vi.mocked(registerResourceTemplateOnServer).mockReturnValue(handle as never);
      registry.events.emit('resourceTemplate.registered', { uriTemplate: 'docs://{id}' });

      registry.events.emit('resourceTemplate.unregistered', 'docs://{id}');

      expect(handle.remove).toHaveBeenCalled();
    });

    it('does not throw when unregistering an unknown key', async () => {
      const { service, registry } = makeService();
      await service.start();
      expect(() =>
        registry.events.emit('tool.unregistered', 'nonexistent'),
      ).not.toThrow();
    });
  });

  // ─── onModuleDestroy ─────────────────────────────────────────────────────

  describe('onModuleDestroy()', () => {
    it('closes the MCP server', async () => {
      const { service } = makeService();
      await service.start();
      await service.onModuleDestroy();
      expect(mockServer.close).toHaveBeenCalled();
    });

    it('removes all registry event listeners', async () => {
      const { service, registry } = makeService();
      await service.start();
      await service.onModuleDestroy();

      expect(registry.events.eventNames()).toHaveLength(0);
    });

    it('calls subscriptionManager.removeSession when provided', async () => {
      const subscriptionManager = { removeSession: vi.fn() };
      const { service } = makeService({ subscriptionManager });
      await service.start();
      await service.onModuleDestroy();
      expect(subscriptionManager.removeSession).toHaveBeenCalledWith('stdio');
    });

    it('calls taskManager.removeSession when provided', async () => {
      const taskManager = { removeSession: vi.fn() };
      const { service } = makeService({ taskManager });
      await service.start();
      await service.onModuleDestroy();
      expect(taskManager.removeSession).toHaveBeenCalledWith('stdio');
    });

    it('does not throw when server was never started', async () => {
      const { service } = makeService();
      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });
});
