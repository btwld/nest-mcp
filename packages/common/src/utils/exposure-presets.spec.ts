import { describe, expect, it } from 'vitest';
import type { ClientContext } from '../interfaces/mcp-exposure.interface';
import { McpTransportType } from '../interfaces/mcp-transport.interface';
import { ANTHROPIC_ADVANCED_TOOL_USE_BETA } from './exposure-capabilities';
import { preferSearchElseLazy } from './exposure-presets';

function ctx(partial: Partial<ClientContext> = {}): ClientContext {
  return { transport: McpTransportType.STREAMABLE_HTTP, ...partial };
}

describe('preferSearchElseLazy', () => {
  it('returns search strategy when the client sent the advanced-tool-use beta header', () => {
    const resolver = preferSearchElseLazy({ eager: { tags: ['core'] } });
    const strategy = resolver(ctx({ betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA] }));
    expect(strategy).toEqual({
      kind: 'search',
      variant: 'bm25',
      eager: { tags: ['core'] },
    });
  });

  it('returns lazy strategy when the client did not send the beta header', () => {
    const resolver = preferSearchElseLazy({ eager: { tags: ['core'] } });
    const strategy = resolver(ctx({ betaHeaders: ['unrelated'] }));
    expect(strategy).toEqual({
      kind: 'lazy',
      eager: { tags: ['core'] },
    });
  });

  it('falls back to lazy on STDIO transports (no headers possible)', () => {
    const resolver = preferSearchElseLazy();
    const strategy = resolver(ctx({ transport: McpTransportType.STDIO }));
    expect(strategy.kind).toBe('lazy');
  });

  it('honours the configured variant when returning search', () => {
    const resolver = preferSearchElseLazy({ variant: 'regex' });
    const strategy = resolver(ctx({ betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA] }));
    expect(strategy.kind === 'search' && strategy.variant).toBe('regex');
  });

  it('threads the eager selector through to both branches', () => {
    const eager = { tags: ['core'] };
    const resolver = preferSearchElseLazy({ eager });
    const searchResult = resolver(ctx({ betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA] }));
    const lazyResult = resolver(ctx());
    expect(searchResult.kind === 'search' && searchResult.eager).toEqual(eager);
    expect(lazyResult.kind === 'lazy' && lazyResult.eager).toEqual(eager);
  });

  it('propagates custom meta-tool names when lazy is selected', () => {
    const resolver = preferSearchElseLazy({
      indexToolName: 'my_index',
      schemaToolName: 'my_schema',
    });
    const lazyResult = resolver(ctx());
    expect(lazyResult).toMatchObject({
      kind: 'lazy',
      indexToolName: 'my_index',
      schemaToolName: 'my_schema',
    });
  });
});
