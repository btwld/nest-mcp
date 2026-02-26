const regexCache = new Map<string, RegExp>();

export function matchGlobPattern(name: string, pattern: string): boolean {
  const cached = regexCache.get(pattern);
  if (cached) return cached.test(name);
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexStr}$`);
  regexCache.set(pattern, regex);
  return regex.test(name);
}
