import type { OpenAPIV3 } from 'openapi-types';

export const petstoreMini: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: { title: 'Petstore mini', version: '1.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        tags: ['pets'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createPet',
        tags: ['pets'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/Pet',
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPetById',
        tags: ['pets'],
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
      delete: {
        operationId: 'deletePet',
        tags: ['pets'],
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '204': { description: 'deleted' } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'string', readOnly: true },
          name: { type: 'string' },
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
        },
      },
      Tag: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      },
    },
  },
};

export const cyclicSchema: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: { title: 'Cyclic', version: '1.0' },
  paths: {
    '/nodes': {
      get: {
        operationId: 'listNodes',
        responses: { '200': { description: 'ok' } },
        parameters: [
          {
            name: 'filter',
            in: 'query',
            schema: { $ref: '#/components/schemas/Node' },
          },
        ],
      },
    },
  },
  components: {
    schemas: {
      Node: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          parent: { $ref: '#/components/schemas/Node' },
        },
      },
    },
  },
};
