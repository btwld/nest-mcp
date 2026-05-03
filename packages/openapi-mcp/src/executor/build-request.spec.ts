import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { petstoreMini } from '../../test/fixtures/petstore-mini';
import type { ToolDescriptor } from '../interfaces/tool-descriptor.interface';
import { collectDescriptors } from '../transformer/collect-descriptors';
import { buildRequest } from './build-request';

const descriptors = collectDescriptors(petstoreMini, { baseUrl: '' });

function findDescriptor(name: string): ToolDescriptor {
  const found = descriptors.find((d) => d.name === name);
  if (!found) throw new Error(`expected descriptor "${name}"`);
  return found;
}

describe('buildRequest', () => {
  it('substitutes path tokens', () => {
    const getById = findDescriptor('getPetById');
    const req = buildRequest('https://api.example.com', getById, { petId: '42' });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.com/pets/42');
    expect(req.body).toBeUndefined();
  });

  it('encodes path values via encodeURIComponent', () => {
    const getById = findDescriptor('getPetById');
    const req = buildRequest('https://api.example.com', getById, { petId: 'a/b' });
    expect(req.url).toBe('https://api.example.com/pets/a%2Fb');
  });

  it('appends query params', () => {
    const list = findDescriptor('listPets');
    const req = buildRequest('https://api.example.com', list, { limit: 5 });
    expect(req.url).toBe('https://api.example.com/pets?limit=5');
  });

  it('serializes JSON body and sets content-type', () => {
    const create = findDescriptor('createPet');
    const req = buildRequest('https://api.example.com', create, { name: 'rex' });
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toEqual({ name: 'rex' });
  });

  it('joins base and path correctly when base has trailing slash', () => {
    const list = findDescriptor('listPets');
    const req = buildRequest('https://api.example.com/', list, {});
    expect(req.url).toBe('https://api.example.com/pets');
  });

  it('preserves descriptor zod schema for validation', () => {
    const getById = findDescriptor('getPetById');
    const result = (getById.zodSchema as z.ZodTypeAny).safeParse({ petId: 'x' });
    expect(result.success).toBe(true);
    const missing = (getById.zodSchema as z.ZodTypeAny).safeParse({});
    expect(missing.success).toBe(false);
  });
});
