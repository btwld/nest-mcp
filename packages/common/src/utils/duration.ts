const TIME_UNITS_MS = new Map<string, number>([
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
]);

const DURATION_REGEX = /^(\d+)([smhd])$/;

/**
 * Parse a duration string (e.g. "30s", "5m", "1h", "7d") into milliseconds.
 * Returns `fallbackMs` if the string is not a valid duration.
 */
export function parseDurationMs(value: string, fallbackMs: number): number {
  const match = value.match(DURATION_REGEX);
  if (!match) return fallbackMs;
  const num = Number.parseInt(match[1], 10);
  const multiplier = TIME_UNITS_MS.get(match[2]);
  return multiplier ? num * multiplier : fallbackMs;
}

/**
 * Parse a duration string (e.g. "30s", "5m", "1h", "7d") into seconds.
 * Returns `fallbackSeconds` if the string is not a valid duration.
 */
export function parseDurationSeconds(value: string, fallbackSeconds: number): number {
  const match = value.match(DURATION_REGEX);
  if (!match) return fallbackSeconds;
  const num = Number.parseInt(match[1], 10);
  const multiplier = TIME_UNITS_MS.get(match[2]);
  return multiplier ? (num * multiplier) / 1_000 : fallbackSeconds;
}
