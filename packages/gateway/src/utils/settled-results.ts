export function collectFulfilled<T>(results: PromiseSettledResult<T[]>[]): T[] {
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
