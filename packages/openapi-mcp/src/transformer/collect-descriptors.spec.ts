import { describe, expect, it } from 'vitest';
import { cyclicSchema, petstoreMini } from '../../test/fixtures/petstore-mini';
import { collectDescriptors } from './collect-descriptors';

describe('collectDescriptors', () => {
  it('emits one descriptor per OpenAPI operation', () => {
    const descriptors = collectDescriptors(petstoreMini, { name: 'pet', baseUrl: '' });
    expect(descriptors).toHaveLength(4);
    expect(descriptors.map((d) => d.name).sort()).toEqual([
      'pet.createPet',
      'pet.deletePet',
      'pet.getPetById',
      'pet.listPets',
    ]);
  });

  it('falls back to ${tag}_${verbSuffix} when operationId is missing', () => {
    const descriptors = collectDescriptors(
      {
        ...petstoreMini,
        paths: {
          '/widgets': {
            get: { tags: ['widgets'], responses: { '200': { description: 'ok' } } },
          },
        },
      },
      { baseUrl: '' },
    );
    expect(descriptors[0].name).toBe('widgets_list');
  });

  it('marks path params required and uses path tokens in pathTemplate', () => {
    const descriptors = collectDescriptors(petstoreMini, { name: 'pet', baseUrl: '' });
    const getById = descriptors.find((d) => d.name === 'pet.getPetById');
    if (!getById) throw new Error('expected pet.getPetById descriptor');
    expect(getById.parameters).toHaveLength(1);
    expect(getById.parameters[0]).toMatchObject({ name: 'petId', in: 'path', required: true });
    expect(getById.request.pathTemplate).toBe('/pets/{petId}');
  });

  it('resolves $ref bodies into a flattened schema and merges into top-level properties', () => {
    const descriptors = collectDescriptors(petstoreMini, { name: 'pet', baseUrl: '' });
    const create = descriptors.find((d) => d.name === 'pet.createPet');
    if (!create) throw new Error('expected pet.createPet descriptor');
    expect(create.body).toBeDefined();
    const properties = create.jsonSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('name');
    expect(properties).toHaveProperty('tags');
  });

  it('breaks ref cycles without throwing', () => {
    const descriptors = collectDescriptors(cyclicSchema, { name: 'g', baseUrl: '' });
    expect(descriptors).toHaveLength(1);
    const filterParam = descriptors[0].parameters.find((p) => p.name === 'filter');
    expect(filterParam).toBeDefined();
  });

  it('honors includeTags / excludeTags', () => {
    const filtered = collectDescriptors(petstoreMini, {
      name: 'pet',
      baseUrl: '',
      excludeTags: ['pets'],
    });
    expect(filtered).toHaveLength(0);
  });

  it('skips operations with only multipart bodies', () => {
    const multipart = {
      ...petstoreMini,
      paths: {
        '/upload': {
          post: {
            operationId: 'upload',
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object' as const,
                    properties: { file: { type: 'string' as const, format: 'binary' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const descriptors = collectDescriptors(multipart, { baseUrl: '' });
    expect(descriptors).toHaveLength(0);
  });
});
