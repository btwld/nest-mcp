import { EventEmitter } from 'node:events';
import type { McpModuleOptions, StreamableHttpTransportOptions } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock register functions (stand-ins for register-handlers exports)
// ---------------------------------------------------------------------------
const mockRegisterTool = vi.fn();
const mockRegisterResource = vi.fn();
const mockRegisterPrompt = vi.fn();
const mockRegisterResourceTemplate = vi.fn();

function makeHandle() {
  return { remove: vi.fn() };
}

type SessionHandle = ReturnType<typeof makeHandle>;

/** Stub that wires up the 8 dynamic-registration event handlers from streamable.service.ts */
function makeRegistryHandlerStub() {
  const registryEvents = new EventEmitter();
  const servers = new Map<string, unknown>();
  const contexts = new Map<string, unknown>();
  const sdkHandles = new Map<string, Map<string, SessionHandle>>();

  // Pre-populate one session
  const sessionId = 'sess-1';
  servers.set(sessionId, { id: 'mock-server' });
  contexts.set(sessionId, { sessionId });
  sdkHandles.set(sessionId, new Map());

  registryEvents.on('tool.registered', (tool: { name: string }) => {
    for (const [sid, srv] of servers) {
      const ctx = contexts.get(sid);
      if (!ctx) continue;
      const handle = mockRegisterTool(srv, tool, undefined, ctx) as SessionHandle;
      sdkHandles.get(sid)?.set(`tool:${tool.name}`, handle);
    }
  });

  registryEvents.on('tool.unregistered', (name: string) => {
    for (const [sid] of servers) {
      const handle = sdkHandles.get(sid)?.get(`tool:${name}`);
      if (handle) {
        handle.remove();
        sdkHandles.get(sid)?.delete(`tool:${name}`);
      }
    }
  });

  registryEvents.on('resource.registered', (resource: { uri: string }) => {
    for (const [sid, srv] of servers) {
      const ctx = contexts.get(sid);
      if (!ctx) continue;
      const handle = mockRegisterResource(srv, resource, undefined, ctx) as SessionHandle;
      sdkHandles.get(sid)?.set(`resource:${resource.uri}`, handle);
    }
  });

  registryEvents.on('resource.unregistered', (uri: string) => {
    for (const [sid] of servers) {
      const handle = sdkHandles.get(sid)?.get(`resource:${uri}`);
      if (handle) {
        handle.remove();
        sdkHandles.get(sid)?.delete(`resource:${uri}`);
      }
    }
  });

  registryEvents.on('prompt.registered', (prompt: { name: string }) => {
    for (const [sid, srv] of servers) {
      const ctx = contexts.get(sid);
      if (!ctx) continue;
      const handle = mockRegisterPrompt(srv, prompt, undefined, ctx) as SessionHandle;
      sdkHandles.get(sid)?.set(`prompt:${prompt.name}`, handle);
    }
  });

  registryEvents.on('prompt.unregistered', (name: string) => {
    for (const [sid] of servers) {
      const handle = sdkHandles.get(sid)?.get(`prompt:${name}`);
      if (handle) {
        handle.remove();
        sdkHandles.get(sid)?.delete(`prompt:${name}`);
      }
    }
  });

  registryEvents.on('resourceTemplate.registered', (template: { uriTemplate: string }) => {
    for (const [sid, srv] of servers) {
      const ctx = contexts.get(sid);
      if (!ctx) continue;
      const handle = mockRegisterResourceTemplate(srv, template, undefined, ctx) as SessionHandle;
      sdkHandles.get(sid)?.set(`resourceTemplate:${template.uriTemplate}`, handle);
    }
  });

  registryEvents.on('resourceTemplate.unregistered', (uriTemplate: string) => {
    for (const [sid] of servers) {
      const handle = sdkHandles.get(sid)?.get(`resourceTemplate:${uriTemplate}`);
      if (handle) {
        handle.remove();
        sdkHandles.get(sid)?.delete(`resourceTemplate:${uriTemplate}`);
      }
    }
  });

  return { registryEvents, servers, contexts, sdkHandles, sessionId };
}

// Minimal mock for McpServer – only the `server.notification` method is exercised here.
function makeMockMcpServer(
  notification: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
) {
  return {
    server: { notification },
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Build a minimal StreamableHttpService stub with only the registry events wired up.
function makeStreamableServiceStub() {
  const registryEvents = new EventEmitter();
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };

  const servers = new Map<string, ReturnType<typeof makeMockMcpServer>>();
  const registryListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];

  // Wire up notification.outbound exactly as in streamable.service.ts
  const onOutboundNotification = ({
    method,
    params,
  }: { method: string; params: Record<string, unknown> }) => {
    for (const server of servers.values()) {
      (server.server as unknown as { notification: (n: unknown) => Promise<void> })
        .notification({ method, params })
        .catch((err: unknown) => logger.warn(`Failed to forward notification to session: ${err}`));
    }
  };

  registryEvents.on('notification.outbound', onOutboundNotification);
  registryListeners.push({
    event: 'notification.outbound',
    listener: onOutboundNotification as (...args: unknown[]) => void,
  });

  return { registryEvents, servers, registryListeners, logger };
}

describe('StreamableHttpService notification.outbound forwarding', () => {
  let stub: ReturnType<typeof makeStreamableServiceStub>;

  beforeEach(() => {
    stub = makeStreamableServiceStub();
  });

  it('forwards notification to all active sessions', () => {
    const notifA = vi.fn().mockResolvedValue(undefined);
    const notifB = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session-a', makeMockMcpServer(notifA));
    stub.servers.set('session-b', makeMockMcpServer(notifB));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 'upstream::t1', status: 'completed' },
    });

    expect(notifA).toHaveBeenCalledWith({
      method: 'notifications/tasks/status',
      params: { taskId: 'upstream::t1', status: 'completed' },
    });
    expect(notifB).toHaveBeenCalledWith({
      method: 'notifications/tasks/status',
      params: { taskId: 'upstream::t1', status: 'completed' },
    });
  });

  it('does nothing when there are no active sessions', () => {
    expect(() =>
      stub.registryEvents.emit('notification.outbound', {
        method: 'notifications/tasks/status',
        params: { taskId: 't1', status: 'running' },
      }),
    ).not.toThrow();
  });

  it('catches and logs errors from server.notification without propagating', async () => {
    const failingNotif = vi.fn().mockRejectedValue(new Error('transport closed'));
    stub.servers.set('session-fail', makeMockMcpServer(failingNotif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't1', status: 'failed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to forward notification to session'),
    );
  });

  it('forwards to remaining sessions when one session fails', async () => {
    const failingNotif = vi.fn().mockRejectedValue(new Error('closed'));
    const successNotif = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session-fail', makeMockMcpServer(failingNotif));
    stub.servers.set('session-ok', makeMockMcpServer(successNotif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't2', status: 'completed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(successNotif).toHaveBeenCalledOnce();
    expect(stub.logger.warn).toHaveBeenCalled();
  });

  it('removes the listener from registryListeners on cleanup', () => {
    for (const { event, listener } of stub.registryListeners) {
      stub.registryEvents.removeListener(event, listener);
    }

    const notif = vi.fn().mockResolvedValue(undefined);
    stub.servers.set('session', makeMockMcpServer(notif));

    stub.registryEvents.emit('notification.outbound', {
      method: 'notifications/tasks/status',
      params: { taskId: 't1', status: 'completed' },
    });

    expect(notif).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dynamic registration event handler tests
// ---------------------------------------------------------------------------
describe('StreamableHttpService dynamic registration event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisterTool.mockImplementation(makeHandle);
    mockRegisterResource.mockImplementation(makeHandle);
    mockRegisterPrompt.mockImplementation(makeHandle);
    mockRegisterResourceTemplate.mockImplementation(makeHandle);
  });

  // ---- tool ----------------------------------------------------------------

  it('calls registerTool and stores handle on tool.registered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    registryEvents.emit('tool.registered', { name: 'my-tool' });

    expect(mockRegisterTool).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('tool:my-tool')).toBe(true);
  });

  it('calls handle.remove and deletes handle on tool.unregistered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    const handle = makeHandle();
    sdkHandles.get(sessionId)?.set('tool:my-tool', handle);

    registryEvents.emit('tool.unregistered', 'my-tool');

    expect(handle.remove).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('tool:my-tool')).toBe(false);
  });

  it('does nothing on tool.unregistered when handle was not stored', () => {
    const { registryEvents } = makeRegistryHandlerStub();
    expect(() => registryEvents.emit('tool.unregistered', 'ghost-tool')).not.toThrow();
  });

  // ---- resource ------------------------------------------------------------

  it('calls registerResource and stores handle on resource.registered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    registryEvents.emit('resource.registered', { uri: 'file:///data.json' });

    expect(mockRegisterResource).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('resource:file:///data.json')).toBe(true);
  });

  it('calls handle.remove and deletes handle on resource.unregistered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    const handle = makeHandle();
    sdkHandles.get(sessionId)?.set('resource:file:///data.json', handle);

    registryEvents.emit('resource.unregistered', 'file:///data.json');

    expect(handle.remove).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('resource:file:///data.json')).toBe(false);
  });

  // ---- prompt --------------------------------------------------------------

  it('calls registerPrompt and stores handle on prompt.registered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    registryEvents.emit('prompt.registered', { name: 'my-prompt' });

    expect(mockRegisterPrompt).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('prompt:my-prompt')).toBe(true);
  });

  it('calls handle.remove and deletes handle on prompt.unregistered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    const handle = makeHandle();
    sdkHandles.get(sessionId)?.set('prompt:my-prompt', handle);

    registryEvents.emit('prompt.unregistered', 'my-prompt');

    expect(handle.remove).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('prompt:my-prompt')).toBe(false);
  });

  // ---- resourceTemplate ----------------------------------------------------

  it('calls registerResourceTemplate and stores handle on resourceTemplate.registered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    registryEvents.emit('resourceTemplate.registered', { uriTemplate: 'file:///{path}' });

    expect(mockRegisterResourceTemplate).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('resourceTemplate:file:///{path}')).toBe(true);
  });

  it('calls handle.remove and deletes handle on resourceTemplate.unregistered', () => {
    const { registryEvents, sdkHandles, sessionId } = makeRegistryHandlerStub();
    const handle = makeHandle();
    sdkHandles.get(sessionId)?.set('resourceTemplate:file:///{path}', handle);

    registryEvents.emit('resourceTemplate.unregistered', 'file:///{path}');

    expect(handle.remove).toHaveBeenCalledOnce();
    expect(sdkHandles.get(sessionId)?.has('resourceTemplate:file:///{path}')).toBe(false);
  });

  // ---- multi-session -------------------------------------------------------

  it('registers on all active sessions when tool.registered fires', () => {
    const { registryEvents, servers, contexts, sdkHandles } = makeRegistryHandlerStub();
    servers.set('sess-2', { id: 'server-2' });
    contexts.set('sess-2', { sessionId: 'sess-2' });
    sdkHandles.set('sess-2', new Map());

    registryEvents.emit('tool.registered', { name: 'shared-tool' });

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
    expect(sdkHandles.get('sess-1')?.has('tool:shared-tool')).toBe(true);
    expect(sdkHandles.get('sess-2')?.has('tool:shared-tool')).toBe(true);
  });

  it('skips sessions that have no context on tool.registered', () => {
    const { registryEvents, servers } = makeRegistryHandlerStub();
    servers.set('sess-orphan', { id: 'orphan-server' });

    registryEvents.emit('tool.registered', { name: 'tool-x' });

    expect(mockRegisterTool).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// buildTransportOptions tests (exercised via the private method's logic)
// ---------------------------------------------------------------------------

/**
 * Mirrors the `buildTransportOptions` logic from streamable.service.ts so we
 * can unit-test the option-merging behavior without instantiating the full
 * service (which requires NestJS DI + real SDK transport).
 */
function buildTransportOptions(
  mcpOptions: McpModuleOptions,
  stateless: boolean,
): Record<string, unknown> {
  const opts = mcpOptions.transportOptions?.streamableHttp;
  return {
    sessionIdGenerator: stateless ? undefined : (opts?.sessionIdGenerator ?? expect.any(Function)),
    enableJsonResponse: opts?.enableJsonResponse,
    eventStore: opts?.eventStore,
    onsessioninitialized: opts?.onsessioninitialized,
    onsessionclosed: opts?.onsessionclosed,
    retryInterval: opts?.retryInterval,
  };
}

function makeOptions(streamableHttp?: StreamableHttpTransportOptions): McpModuleOptions {
  return {
    name: 'test-server',
    version: '1.0.0',
    transport: McpTransportType.STREAMABLE_HTTP,
    transportOptions: streamableHttp ? { streamableHttp } : undefined,
  };
}

describe('buildTransportOptions logic', () => {
  it('returns default sessionIdGenerator for stateful mode without custom generator', () => {
    const result = buildTransportOptions(makeOptions(), false);
    expect(result.sessionIdGenerator).toEqual(expect.any(Function));
    expect(result.enableJsonResponse).toBeUndefined();
    expect(result.eventStore).toBeUndefined();
    expect(result.retryInterval).toBeUndefined();
  });

  it('sets sessionIdGenerator to undefined for stateless mode', () => {
    const result = buildTransportOptions(
      makeOptions({ stateless: true, sessionIdGenerator: () => 'custom-id' }),
      true,
    );
    expect(result.sessionIdGenerator).toBeUndefined();
  });

  it('uses custom sessionIdGenerator in stateful mode', () => {
    const customGenerator = () => 'my-custom-session-id';
    const result = buildTransportOptions(
      makeOptions({ sessionIdGenerator: customGenerator }),
      false,
    );
    expect(result.sessionIdGenerator).toBe(customGenerator);
  });

  it('passes enableJsonResponse through', () => {
    const result = buildTransportOptions(makeOptions({ enableJsonResponse: true }), false);
    expect(result.enableJsonResponse).toBe(true);
  });

  it('passes eventStore through', () => {
    const store = {
      storeEvent: vi.fn(),
      replayEventsAfter: vi.fn(),
    };
    const result = buildTransportOptions(makeOptions({ eventStore: store }), false);
    expect(result.eventStore).toBe(store);
  });

  it('passes retryInterval through', () => {
    const result = buildTransportOptions(makeOptions({ retryInterval: 5000 }), false);
    expect(result.retryInterval).toBe(5000);
  });

  it('passes onsessioninitialized callback through', () => {
    const cb = vi.fn();
    const result = buildTransportOptions(makeOptions({ onsessioninitialized: cb }), false);
    expect(result.onsessioninitialized).toBe(cb);
  });

  it('passes onsessionclosed callback through', () => {
    const cb = vi.fn();
    const result = buildTransportOptions(makeOptions({ onsessionclosed: cb }), false);
    expect(result.onsessionclosed).toBe(cb);
  });

  it('ignores all SDK options when transportOptions is undefined', () => {
    const result = buildTransportOptions(
      { name: 'test', version: '1.0.0', transport: McpTransportType.STREAMABLE_HTTP },
      false,
    );
    expect(result.enableJsonResponse).toBeUndefined();
    expect(result.eventStore).toBeUndefined();
    expect(result.onsessioninitialized).toBeUndefined();
    expect(result.onsessionclosed).toBeUndefined();
    expect(result.retryInterval).toBeUndefined();
  });

  it('passes all options together', () => {
    const generator = () => 'sess-42';
    const store = { storeEvent: vi.fn(), replayEventsAfter: vi.fn() };
    const onInit = vi.fn();
    const onClose = vi.fn();

    const result = buildTransportOptions(
      makeOptions({
        sessionIdGenerator: generator,
        enableJsonResponse: true,
        eventStore: store,
        onsessioninitialized: onInit,
        onsessionclosed: onClose,
        retryInterval: 3000,
      }),
      false,
    );

    expect(result.sessionIdGenerator).toBe(generator);
    expect(result.enableJsonResponse).toBe(true);
    expect(result.eventStore).toBe(store);
    expect(result.onsessioninitialized).toBe(onInit);
    expect(result.onsessionclosed).toBe(onClose);
    expect(result.retryInterval).toBe(3000);
  });
});
