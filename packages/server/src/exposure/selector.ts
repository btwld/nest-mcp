import type { ToolMetadata, ToolSelector } from '@nest-mcp/common';

/**
 * Evaluate a {@link ToolSelector} against a tool's metadata.
 *
 * - Array form: inclusion test against the tool name.
 * - `{ tags }` form: true if the tool has any of the given tags.
 * - Function form: delegated to the predicate.
 */
export function matchesSelector(meta: ToolMetadata, selector: ToolSelector): boolean {
  if (typeof selector === 'function') {
    return selector(meta);
  }
  if (Array.isArray(selector)) {
    return selector.includes(meta.name);
  }
  const toolTags = meta.tags ?? [];
  return selector.tags.some((tag) => toolTags.includes(tag));
}

/**
 * Decide whether a tool is "eager" under a given strategy's selector.
 * Per-tool `exposure` overrides win over the module selector:
 *  - `exposure: 'eager'`    → always eager
 *  - `exposure: 'deferred'` → never eager
 *  - `exposure: 'auto'` or unset → consult the selector (if none supplied, default to eager)
 */
export function isEager(meta: ToolMetadata, selector: ToolSelector | undefined): boolean {
  if (meta.exposure === 'eager') return true;
  if (meta.exposure === 'deferred') return false;
  if (!selector) return true;
  return matchesSelector(meta, selector);
}
