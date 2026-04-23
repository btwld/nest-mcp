import type { ClientContext } from '../interfaces/mcp-exposure.interface';
import type { McpTransportType } from '../interfaces/mcp-transport.interface';

/**
 * Narrow shape of the raw transport request object used for header extraction.
 * Matches Node's IncomingMessage / Fastify / Express without importing them.
 */
interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Parses a comma-separated header value (`"a, b, c"`) into trimmed tokens.
 * Handles both `string` and `string[]` because Node surfaces repeated headers
 * as arrays.
 */
export function parseBetaHeaders(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  const raw = Array.isArray(value) ? value.join(',') : value;
  const parts = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export interface BuildClientContextInput {
  transport: McpTransportType;
  /** Raw transport request — typed loosely because STDIO has none. */
  request?: unknown;
  clientInfo?: { name: string; version: string };
  model?: string;
}

/**
 * Constructs a `ClientContext` from loose transport inputs. Safe to call on
 * STDIO (no headers) — `betaHeaders` will simply be undefined.
 *
 * Header lookup is case-insensitive; Node lowercases incoming header names
 * for Express/Fastify, so we check the lowercase form first and fall through
 * to exact-case only as a fallback.
 */
export function buildClientContext(input: BuildClientContextInput): ClientContext {
  const headers = (input.request as RequestWithHeaders | undefined)?.headers;
  const rawBeta = headers?.['anthropic-beta'] ?? headers?.['Anthropic-Beta'];
  const betaHeaders = parseBetaHeaders(rawBeta);

  return {
    transport: input.transport,
    ...(input.clientInfo ? { clientInfo: input.clientInfo } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(betaHeaders ? { betaHeaders } : {}),
  };
}
