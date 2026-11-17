/**
 * Tool-name guidance from the MCP specification: 1–128 characters drawn from
 * ASCII letters, digits, `_`, `-` and `.`.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSpecCompliantToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
