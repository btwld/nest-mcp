import type { McpExecutionContext } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';

export function mockMcpContext(overrides: Partial<McpExecutionContext> = {}): McpExecutionContext {
  return {
    sessionId: 'test-session',
    transport: McpTransportType.STDIO,
    reportProgress: async () => {},
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    metadata: {},
    ...overrides,
  };
}
