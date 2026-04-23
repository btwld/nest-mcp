import { EventEmitter } from 'node:events';
import {
  ANTHROPIC_ADVANCED_TOOL_USE_BETA,
  type ClientContext,
  type ExposureStrategyResolver,
  META_DEFER_LOADING,
  type McpModuleOptions,
  McpTransportType,
  type ToolMetadata,
} from '@nest-mcp/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpRegistryService, RegisteredTool } from '../discovery/registry.service';
import { ExposureService } from './exposure.service';

function makeTool(overrides: Partial<RegisteredTool>): RegisteredTool {
  return {
    name: 'tool',
    description: 'desc',
    methodName: 'fn',
    target: class {} as unknown as abstract new (...args: unknown[]) => unknown,
    instance: {},
    ...overrides,
  };
}

function makeEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, description: `${name} description`, inputSchema: { type: 'object' }, ...extra };
}

function makeRegistry(
  tools: RegisteredTool[] = [],
): McpRegistryService & { __added: RegisteredTool[] } {
  const byName = new Map<string, RegisteredTool>(tools.map((t) => [t.name, t]));
  const added: RegisteredTool[] = [];
  const mock = {
    events: new EventEmitter(),
    getAllTools: vi.fn(() => Array.from(byName.values())),
    getTool: vi.fn((name: string) => byName.get(name)),
    registerTool: vi.fn((tool: RegisteredTool) => {
      byName.set(tool.name, tool);
      added.push(tool);
    }),
    unregisterTool: vi.fn(),
    __added: added,
  };
  return mock as unknown as McpRegistryService & { __added: RegisteredTool[] };
}

function ctx(partial: Partial<ClientContext> = {}): ClientContext {
  return { transport: McpTransportType.STREAMABLE_HTTP, ...partial };
}

const baseOptions: McpModuleOptions = {
  name: 'test',
  version: '0.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
};

describe('ExposureService — resolveForClient', () => {
  it('returns the static strategy verbatim', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'eager' } },
      makeRegistry(),
    );
    expect(svc.resolveForClient(ctx())).toEqual({ kind: 'eager' });
  });

  it('invokes the resolver function with the provided client context', () => {
    const spy: ExposureStrategyResolver = vi.fn(() => ({ kind: 'eager' }));
    const svc = new ExposureService({ ...baseOptions, exposure: spy }, makeRegistry());
    const c = ctx({ model: 'claude-opus-4-7' });
    svc.resolveForClient(c);
    expect(spy).toHaveBeenCalledWith(c);
  });

  it('defaults to eager when no exposure is configured', () => {
    const svc = new ExposureService(baseOptions, makeRegistry());
    expect(svc.resolveForClient(ctx())).toEqual({ kind: 'eager' });
  });
});

describe('ExposureService — applyStrategy: eager', () => {
  it('returns entries unchanged under eager', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'eager' } },
      makeRegistry(),
    );
    const entries = [makeEntry('a'), makeEntry('b')];
    const metas = new Map<string, ToolMetadata>([
      ['a', makeTool({ name: 'a' })],
      ['b', makeTool({ name: 'b' })],
    ]);
    expect(svc.applyStrategy(entries, metas, ctx())).toEqual(entries);
  });
});

describe('ExposureService — applyStrategy: search', () => {
  it('annotates deferred entries with _meta.defer_loading = true', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'search', variant: 'bm25', eager: { tags: ['core'] } } },
      makeRegistry(),
    );
    const entries = [makeEntry('a'), makeEntry('b')];
    const metas = new Map<string, ToolMetadata>([
      ['a', makeTool({ name: 'a', tags: ['core'] })],
      ['b', makeTool({ name: 'b', tags: ['rare'] })],
    ]);
    const result = svc.applyStrategy(entries, metas, ctx());
    expect(result[0]._meta).toBeUndefined();
    expect(result[1]._meta).toEqual({ [META_DEFER_LOADING]: true });
  });

  it('preserves existing _meta entries when annotating', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'search', variant: 'bm25', eager: ['a'] } },
      makeRegistry(),
    );
    const entries = [makeEntry('b', { _meta: { vendor: 'x' } })];
    const metas = new Map<string, ToolMetadata>([['b', makeTool({ name: 'b' })]]);
    const result = svc.applyStrategy(entries, metas, ctx());
    expect(result[0]._meta).toEqual({ vendor: 'x', [META_DEFER_LOADING]: true });
  });

  it('respects per-tool exposure: "eager" even when selector does not include the tool', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'search', variant: 'bm25', eager: ['nothing'] } },
      makeRegistry(),
    );
    const entries = [makeEntry('a')];
    const metas = new Map<string, ToolMetadata>([
      ['a', makeTool({ name: 'a', exposure: 'eager' })],
    ]);
    const result = svc.applyStrategy(entries, metas, ctx());
    expect(result[0]._meta).toBeUndefined();
  });
});

describe('ExposureService — applyStrategy: lazy', () => {
  it('filters out tools that do not match the eager selector', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy', eager: { tags: ['core'] } } },
      makeRegistry(),
    );
    const entries = [makeEntry('a'), makeEntry('b'), makeEntry('c')];
    const metas = new Map<string, ToolMetadata>([
      ['a', makeTool({ name: 'a', tags: ['core'] })],
      ['b', makeTool({ name: 'b', tags: ['rare'] })],
      ['c', makeTool({ name: 'c', tags: ['core', 'rare'] })],
    ]);
    const result = svc.applyStrategy(entries, metas, ctx());
    const names = result.map((e) => e.name);
    expect(names).toContain('a');
    expect(names).toContain('c');
    expect(names).not.toContain('b');
  });

  it('keeps the meta-tools in the response when kind is lazy', () => {
    const registry = makeRegistry();
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy', eager: [] } },
      registry,
    );
    svc.onApplicationBootstrap();
    expect(registry.__added.map((t) => t.name).sort()).toEqual([
      'get_tool_schema',
      'list_available_tools',
    ]);

    const entries = [
      makeEntry('a'),
      makeEntry('list_available_tools'),
      makeEntry('get_tool_schema'),
    ];
    const metas = new Map<string, ToolMetadata>([
      ['a', makeTool({ name: 'a', tags: [] })],
      ['list_available_tools', makeTool({ name: 'list_available_tools', exposure: 'eager' })],
      ['get_tool_schema', makeTool({ name: 'get_tool_schema', exposure: 'eager' })],
    ]);
    const result = svc.applyStrategy(entries, metas, ctx());
    const names = result.map((e) => e.name);
    expect(names).toContain('list_available_tools');
    expect(names).toContain('get_tool_schema');
    expect(names).not.toContain('a'); // 'a' is not eager
  });
});

describe('ExposureService — meta-tool registration (onApplicationBootstrap)', () => {
  it('does not register meta-tools for eager-only configurations', () => {
    const registry = makeRegistry();
    const svc = new ExposureService({ ...baseOptions, exposure: { kind: 'eager' } }, registry);
    svc.onApplicationBootstrap();
    expect(registry.__added).toHaveLength(0);
  });

  it('registers lazy meta-tools on bootstrap when lazy is reachable', () => {
    const registry = makeRegistry();
    const svc = new ExposureService({ ...baseOptions, exposure: { kind: 'lazy' } }, registry);
    svc.onApplicationBootstrap();
    expect(registry.__added.map((t) => t.name).sort()).toEqual([
      'get_tool_schema',
      'list_available_tools',
    ]);
  });

  it('conservatively registers meta-tools when a resolver is configured', () => {
    const registry = makeRegistry();
    const resolver: ExposureStrategyResolver = () => ({ kind: 'search', variant: 'bm25' });
    const svc = new ExposureService({ ...baseOptions, exposure: resolver }, registry);
    svc.onApplicationBootstrap();
    expect(registry.__added.map((t) => t.name).sort()).toEqual([
      'get_tool_schema',
      'list_available_tools',
    ]);
  });

  it('honours custom indexToolName / schemaToolName', () => {
    const registry = makeRegistry();
    const svc = new ExposureService(
      {
        ...baseOptions,
        exposure: { kind: 'lazy', indexToolName: 'my_index', schemaToolName: 'my_schema' },
      },
      registry,
    );
    svc.onApplicationBootstrap();
    expect(registry.__added.map((t) => t.name).sort()).toEqual(['my_index', 'my_schema']);
  });
});

describe('ExposureService — validation (onApplicationBootstrap)', () => {
  it('throws when a meta-tool name collides with an existing tool', () => {
    const existing = makeTool({ name: 'list_available_tools' });
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy' } },
      makeRegistry([existing]),
    );
    expect(() => svc.onApplicationBootstrap()).toThrow(/collides with an existing tool/);
  });

  it('throws when kind: search has zero eager tools (default behavior)', () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'search', variant: 'bm25', eager: ['nonexistent'] } },
      makeRegistry([makeTool({ name: 'a' }), makeTool({ name: 'b' })]),
    );
    expect(() => svc.onApplicationBootstrap()).toThrow(/zero eager tools/);
  });

  it('does not throw when onAllDeferred is "warn"', () => {
    const svc = new ExposureService(
      {
        ...baseOptions,
        exposure: {
          kind: 'search',
          variant: 'bm25',
          eager: ['nonexistent'],
          onAllDeferred: 'warn',
        },
      },
      makeRegistry([makeTool({ name: 'a' })]),
    );
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
  });

  it('skips search validation when the strategy is a resolver (non-static)', () => {
    const svc = new ExposureService(
      {
        ...baseOptions,
        exposure: () => ({ kind: 'search', variant: 'bm25', eager: ['nonexistent'] }),
      },
      makeRegistry([makeTool({ name: 'a' })]),
    );
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
  });
});

describe('ExposureService — handleListAvailableTools', () => {
  it('returns tools without schemas, paginated', async () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy' } },
      makeRegistry([
        makeTool({ name: 'alpha', description: 'first tool' }),
        makeTool({ name: 'beta', description: 'second tool' }),
      ]),
    );
    svc.onApplicationBootstrap();
    const result = await svc.handleListAvailableTools({});
    // The meta-tools should not appear in the index.
    expect(result.tools.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
    for (const t of result.tools) {
      expect('inputSchema' in t).toBe(false);
    }
  });

  it('filters by query substring on name or description', async () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy' } },
      makeRegistry([
        makeTool({ name: 'search_issues', description: 'find issues' }),
        makeTool({ name: 'list_repos', description: 'enumerate repositories' }),
      ]),
    );
    svc.onApplicationBootstrap();
    const result = await svc.handleListAvailableTools({ query: 'issue' });
    expect(result.tools.map((t) => t.name)).toEqual(['search_issues']);
  });

  it('filters by AND of tags', async () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy' } },
      makeRegistry([
        makeTool({ name: 'a', tags: ['core', 'fast'] }),
        makeTool({ name: 'b', tags: ['core'] }),
        makeTool({ name: 'c', tags: ['rare', 'fast'] }),
      ]),
    );
    svc.onApplicationBootstrap();
    const result = await svc.handleListAvailableTools({ tags: ['core', 'fast'] });
    expect(result.tools.map((t) => t.name)).toEqual(['a']);
  });
});

describe('ExposureService — handleGetToolSchema', () => {
  it('returns full schemas for known names and records unknowns in notFound', async () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy' } },
      makeRegistry([
        makeTool({
          name: 'alpha',
          description: 'first',
          inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        }),
      ]),
    );
    svc.onApplicationBootstrap();
    const result = await svc.handleGetToolSchema({ names: ['alpha', 'ghost'] });
    expect(result.notFound).toEqual(['ghost']);
    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]?.name).toBe('alpha');
    expect(result.schemas[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('caps batch size to maxBatchSize', async () => {
    const svc = new ExposureService(
      { ...baseOptions, exposure: { kind: 'lazy', maxBatchSize: 2 } },
      makeRegistry([makeTool({ name: 'a' }), makeTool({ name: 'b' }), makeTool({ name: 'c' })]),
    );
    svc.onApplicationBootstrap();
    const result = await svc.handleGetToolSchema({ names: ['a', 'b', 'c'] });
    expect(result.schemas.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('ExposureService — integration with capability helpers', () => {
  it('a resolver using clientSupports.search picks search when the beta header is present', () => {
    const resolver: ExposureStrategyResolver = (c) =>
      c.betaHeaders?.includes(ANTHROPIC_ADVANCED_TOOL_USE_BETA)
        ? { kind: 'search', variant: 'bm25' }
        : { kind: 'lazy' };
    const svc = new ExposureService({ ...baseOptions, exposure: resolver }, makeRegistry());
    const withBeta = svc.resolveForClient(ctx({ betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA] }));
    const withoutBeta = svc.resolveForClient(ctx());
    expect(withBeta.kind).toBe('search');
    expect(withoutBeta.kind).toBe('lazy');
  });
});
