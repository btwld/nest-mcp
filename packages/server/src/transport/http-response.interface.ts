export interface HttpResponse {
  status?: (code: number) => HttpResponse;
  json?: (body: unknown) => void;
  code?: (code: number) => HttpResponse;
  send?: (body: unknown) => void;
}
