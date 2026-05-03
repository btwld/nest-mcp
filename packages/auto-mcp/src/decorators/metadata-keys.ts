export const MCP_AUTO_EXPOSE_METADATA = 'nest-mcp:auto:expose';
export const MCP_AUTO_HIDE_METADATA = 'nest-mcp:auto:hide';
export const MCP_AUTO_CONTROLLER_METADATA = 'nest-mcp:auto:controller';

export interface McpExposeOptions {
  name?: string;
  description?: string;
  /** A pre-built JSON Schema (object). Wins over class-validator and design:paramtypes. */
  schema?: Record<string, unknown>;
  tags?: string[];
  serverName?: string;
}

export interface McpExposeControllerOptions {
  mode?: 'all' | 'opt-in';
  namespace?: string | false;
  serverName?: string;
}
