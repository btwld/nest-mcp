/**
 * Narrow an `unknown` value to `string`, returning `undefined` on mismatch.
 * Pair with `??` for fallback chains:
 *
 * ```ts
 * const name = asString(raw.name) ?? asString(raw.login) ?? 'anonymous';
 * ```
 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Type guard for "non-null object" — i.e. anything that can be indexed with
 * a string key. Replaces the very common `typeof v === 'object' && v !== null`
 * + `as Record<string, unknown>` cast pair.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
