export interface NamedItem {
  name: string;
}

export function deduplicateNames<T extends NamedItem>(items: T[]): T[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const item of items) {
    if ((counts.get(item.name) ?? 0) <= 1) continue;
    const idx = (seen.get(item.name) ?? 0) + 1;
    seen.set(item.name, idx);
    if (idx > 1) {
      item.name = `${item.name}_${idx}`;
    }
  }
  return items;
}
