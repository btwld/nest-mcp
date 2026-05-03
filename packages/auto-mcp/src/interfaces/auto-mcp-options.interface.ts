import type { Type } from '@nestjs/common';

export interface AutoMcpOptions {
  /**
   * `'all'` (default): every controller method becomes an MCP tool unless
   * marked with `@McpHide()`.
   * `'opt-in'`: only methods with `@McpExpose()` are registered.
   */
  mode?: 'all' | 'opt-in';
  /** Restrict the scan to these controller classes. Defaults to all controllers. */
  controllers?: Type[];
  include?: Array<string | RegExp | { controller: Type | string; method?: string }>;
  exclude?: Array<string | RegExp | { controller: Type | string; method?: string }>;
  /**
   * Namespace prefix for tool names. Default: `'nestjs'` → `nestjs.users.findOne`.
   * Set to `false` to emit flat names (with dedup-suffix on collision).
   */
  namespace?: string | false;
  /**
   * How to handle DTOs that we cannot synthesize a useful schema for:
   *   - `'warn'` (default): emit a permissive `{ type: 'object', additionalProperties: true }`
   *   - `'throw'`: error at boot
   *   - `'skip'`: omit the route entirely
   */
  onSchemaError?: 'warn' | 'throw' | 'skip';
  /** Map MCP-side principal to the shape your guards expect on `req.user`. */
  mapPrincipalToRequestUser?: (mcpPrincipal: unknown) => unknown;
  /** Target server name when running in multi-server mode. */
  serverName?: string;
}
