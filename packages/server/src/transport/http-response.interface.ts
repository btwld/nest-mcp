export interface HttpResponse {
  status?: (code: number) => HttpResponse;
  json?: (body: unknown) => void;
  code?: (code: number) => HttpResponse;
  send?: (body: unknown) => void;
  /** Express / Node `ServerResponse` header setter. */
  setHeader?: (name: string, value: string) => unknown;
  /** Fastify reply header setter. */
  header?: (name: string, value: string) => unknown;
}
