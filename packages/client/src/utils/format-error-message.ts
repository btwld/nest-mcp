export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
