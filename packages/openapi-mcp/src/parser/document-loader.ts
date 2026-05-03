import type { OpenAPIDocument, SourceConfig } from '../interfaces/openapi-mcp-options.interface';

/**
 * Resolve the OpenAPI document for a source. Resolution order:
 *   1. `document` if provided
 *   2. `documentFactory()` if provided
 *   3. `documentUrl` (JSON only — pre-bundle YAML to JSON)
 *
 * Throws when none is provided or when the URL fetch fails.
 */
export async function loadOpenApiDocument(source: SourceConfig): Promise<OpenAPIDocument> {
  if (source.document) return source.document;

  if (source.documentFactory) {
    const result = await source.documentFactory();
    return result;
  }

  if (source.documentUrl) {
    const response = await fetch(source.documentUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch OpenAPI document from ${source.documentUrl}: ${response.status} ${response.statusText}`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('yaml') || /\.ya?ml(\?|$)/.test(source.documentUrl)) {
      throw new Error(
        `OpenAPI document at ${source.documentUrl} appears to be YAML; v1 supports JSON only. Pre-bundle to JSON or use \`documentFactory\`.`,
      );
    }
    return (await response.json()) as OpenAPIDocument;
  }

  throw new Error(
    'OpenApiMcpModule: source must provide one of `document`, `documentFactory`, or `documentUrl`.',
  );
}
