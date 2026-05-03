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
