import { describe, expect, it } from 'vitest';
import { McpTransportType } from '../interfaces/mcp-transport.interface';
import { ANTHROPIC_ADVANCED_TOOL_USE_BETA, clientSupports } from './exposure-capabilities';

describe('clientSupports.search', () => {
  it('is false when no beta headers are present', () => {
    expect(clientSupports.search({ transport: McpTransportType.STDIO })).toBe(false);
  });

  it('is false when beta headers are present but missing the advanced-tool-use token', () => {
    expect(
      clientSupports.search({
        transport: McpTransportType.STREAMABLE_HTTP,
        betaHeaders: ['prompt-caching-2024-07-31'],
      }),
    ).toBe(false);
  });

  it('is true when the beta header list includes the advanced-tool-use token', () => {
    expect(
      clientSupports.search({
        transport: McpTransportType.STREAMABLE_HTTP,
        betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA],
      }),
    ).toBe(true);
  });

  it('is true when advanced-tool-use appears alongside other beta tokens', () => {
    expect(
      clientSupports.search({
        transport: McpTransportType.STREAMABLE_HTTP,
        betaHeaders: ['unrelated', ANTHROPIC_ADVANCED_TOOL_USE_BETA, 'another'],
      }),
    ).toBe(true);
  });
});

describe('clientSupports.codeMode', () => {
  it('is always false in this release', () => {
    expect(clientSupports.codeMode({ transport: McpTransportType.STDIO })).toBe(false);
    expect(
      clientSupports.codeMode({
        transport: McpTransportType.STREAMABLE_HTTP,
        betaHeaders: [ANTHROPIC_ADVANCED_TOOL_USE_BETA],
      }),
    ).toBe(false);
  });
});
