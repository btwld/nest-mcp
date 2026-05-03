import type { OpenAPIV3 } from 'openapi-types';

/**
 * A trimmed Petstore-style OpenAPI document. We embed it inline here so the
 * example runs offline; in production you'd more likely pass `documentUrl` to
 * fetch from a real upstream's `/openapi.json`.
 */
export const petstoreDoc: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: { title: 'Petstore example', version: '1.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        tags: ['pets'],
        summary: 'List pets',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPetById',
        tags: ['pets'],
        summary: 'Get a pet by id',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};
