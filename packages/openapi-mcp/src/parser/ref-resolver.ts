import type { OpenAPIDocument } from '../interfaces/openapi-mcp-options.interface';

type AnyRecord = Record<string, unknown>;

export interface ResolveLogger {
  warn(message: string): void;
}

const DEFAULT_LOGGER: ResolveLogger = { warn: () => {} };

/**
 * Resolve a single `$ref` against the document. Returns the referenced object
 * or `undefined` when the ref cannot be resolved (e.g., external ref or missing).
 */
export function resolveRef(doc: OpenAPIDocument, ref: string): AnyRecord | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const segments = ref.slice(2).split('/');
  let current: unknown = doc;
  for (const segment of segments) {
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object') return undefined;
    current = (current as AnyRecord)[decoded];
    if (current === undefined) return undefined;
  }
  return current as AnyRecord | undefined;
}

/**
 * Recursively inline every `$ref` in `schema` into a self-contained object.
 * Cycles are detected via the `visited` set; on a cycle, the inner ref is
 * replaced with `{ type: 'object', additionalProperties: true }` to break the
 * loop without throwing.
 */
export function resolveSchemaDeep(
  doc: OpenAPIDocument,
  schema: unknown,
  logger: ResolveLogger = DEFAULT_LOGGER,
  visited: Set<string> = new Set(),
): AnyRecord | undefined {
  if (!schema || typeof schema !== 'object') return schema as AnyRecord | undefined;

  let current = schema as AnyRecord;

  if (typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (visited.has(ref)) {
      logger.warn(`Cycle detected on $ref ${ref}; substituting open-object schema.`);
      return { type: 'object', additionalProperties: true };
    }
    const resolved = resolveRef(doc, ref);
    if (!resolved) {
      logger.warn(`Could not resolve $ref ${ref}; substituting open-object schema.`);
      return { type: 'object', additionalProperties: true };
    }
    return resolveSchemaDeep(doc, resolved, logger, new Set([...visited, ref]));
  }

  // Shallow-clone so we never mutate the input document.
  current = { ...current };

  if (current.properties && typeof current.properties === 'object') {
    const next: AnyRecord = {};
    for (const [key, value] of Object.entries(current.properties as AnyRecord)) {
      next[key] = resolveSchemaDeep(doc, value, logger, new Set(visited)) ?? value;
    }
    current.properties = next;
  }

  if (current.items && typeof current.items === 'object') {
    current.items = resolveSchemaDeep(doc, current.items, logger, new Set(visited)) ?? {
      type: 'string',
    };
  }

  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    if (Array.isArray(current[key])) {
      current[key] = (current[key] as unknown[]).map(
        (sub) => resolveSchemaDeep(doc, sub, logger, new Set(visited)) ?? sub,
      );
    }
  }

  if (current.additionalProperties && typeof current.additionalProperties === 'object') {
    current.additionalProperties =
      resolveSchemaDeep(doc, current.additionalProperties, logger, new Set(visited)) ??
      current.additionalProperties;
  }

  return current;
}
