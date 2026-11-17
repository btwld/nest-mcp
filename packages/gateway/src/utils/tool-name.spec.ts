import { isSpecCompliantToolName } from './tool-name';

describe('isSpecCompliantToolName', () => {
  it('accepts letters, digits, underscore, dash and dot', () => {
    expect(isSpecCompliantToolName('gh_list-repos.v2')).toBe(true);
  });

  it('rejects empty names', () => {
    expect(isSpecCompliantToolName('')).toBe(false);
  });

  it('rejects names longer than 128 characters', () => {
    expect(isSpecCompliantToolName('a'.repeat(128))).toBe(true);
    expect(isSpecCompliantToolName('a'.repeat(129))).toBe(false);
  });

  it('rejects spaces, slashes and non-ASCII characters', () => {
    expect(isSpecCompliantToolName('gh_list repos')).toBe(false);
    expect(isSpecCompliantToolName('gh/list')).toBe(false);
    expect(isSpecCompliantToolName('gh_lïst')).toBe(false);
  });
});
