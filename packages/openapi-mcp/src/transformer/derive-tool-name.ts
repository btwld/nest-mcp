import type { OperationContext } from '../interfaces/openapi-mcp-options.interface';

const VERB_SUFFIX: Record<string, string> = {
  get: 'get',
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
  head: 'head',
  options: 'options',
};

/**
 * Convert an OpenAPI operation context into a tool name (without namespace).
 * Prefers `operationId` when present; otherwise falls back to
 * `${tag}_${verbSuffix}` where `verbSuffix` is `list` for unparameterized GET.
 */
export function deriveToolName(ctx: OperationContext): string {
  if (ctx.operationId) {
    return sanitize(ctx.operationId);
  }

  const tag = (ctx.tags[0] ?? 'op').toLowerCase();
  const verb = ctx.method.toLowerCase();
  let suffix = VERB_SUFFIX[verb] ?? verb;
  if (verb === 'get' && !ctx.path.includes('{')) {
    suffix = 'list';
  }
  return sanitize(`${tag}_${suffix}`);
}

function sanitize(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 64);
}
