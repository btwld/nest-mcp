import { describe, it, expect } from 'vitest';
import {
  parseUriTemplate,
  matchUriTemplate,
  expandUriTemplate,
  getTemplateParams,
} from './uri-template';

describe('parseUriTemplate', () => {
  it('should parse a template with one parameter', () => {
    const result = parseUriTemplate('/users/{id}');
    expect(result.paramNames).toEqual(['id']);
    expect(result.regex).toBeInstanceOf(RegExp);
  });

  it('should parse a template with multiple parameters', () => {
    const result = parseUriTemplate('/users/{userId}/posts/{postId}');
    expect(result.paramNames).toEqual(['userId', 'postId']);
  });

  it('should parse a template with no parameters', () => {
    const result = parseUriTemplate('/static/path');
    expect(result.paramNames).toEqual([]);
  });

  it('should generate a regex that matches the template pattern', () => {
    const { regex } = parseUriTemplate('/users/{id}');
    expect(regex.test('/users/123')).toBe(true);
    expect(regex.test('/users/')).toBe(false);
    expect(regex.test('/other/123')).toBe(false);
  });
});

describe('matchUriTemplate', () => {
  it('should match a URI and extract parameters', () => {
    const result = matchUriTemplate('/users/{id}', '/users/42');
    expect(result).toEqual({ params: { id: '42' } });
  });

  it('should match multiple parameters', () => {
    const result = matchUriTemplate(
      '/users/{userId}/posts/{postId}',
      '/users/1/posts/99',
    );
    expect(result).toEqual({ params: { userId: '1', postId: '99' } });
  });

  it('should return null for non-matching URI', () => {
    const result = matchUriTemplate('/users/{id}', '/posts/42');
    expect(result).toBeNull();
  });

  it('should decode URI-encoded parameter values', () => {
    const result = matchUriTemplate('/files/{name}', '/files/hello%20world');
    expect(result).toEqual({ params: { name: 'hello world' } });
  });
});

describe('expandUriTemplate', () => {
  it('should expand a template with parameters', () => {
    const result = expandUriTemplate('/users/{id}', { id: '42' });
    expect(result).toBe('/users/42');
  });

  it('should expand multiple parameters', () => {
    const result = expandUriTemplate('/users/{userId}/posts/{postId}', {
      userId: '1',
      postId: '99',
    });
    expect(result).toBe('/users/1/posts/99');
  });

  it('should URI-encode parameter values', () => {
    const result = expandUriTemplate('/files/{name}', {
      name: 'hello world',
    });
    expect(result).toBe('/files/hello%20world');
  });

  it('should throw on missing parameter', () => {
    expect(() => expandUriTemplate('/users/{id}', {})).toThrow(
      'Missing URI template parameter: id',
    );
  });
});

describe('getTemplateParams', () => {
  it('should return parameter names from a template', () => {
    expect(getTemplateParams('/users/{id}')).toEqual(['id']);
  });

  it('should return multiple parameter names', () => {
    expect(
      getTemplateParams('/users/{userId}/posts/{postId}'),
    ).toEqual(['userId', 'postId']);
  });

  it('should return empty array for no parameters', () => {
    expect(getTemplateParams('/static/path')).toEqual([]);
  });
});
