import { describe, expect, it } from 'vitest';
import { audienceMatches } from './audience.util';

describe('audienceMatches', () => {
  const resource = 'https://h/mcp';

  // --- Single string aud ---

  it('matches an exact URL audience', () => {
    expect(audienceMatches('https://h/mcp', resource)).toBe(true);
  });

  it('does not match when the audience is only a path prefix of the resource', () => {
    // Exact matching: a broader audience must not cover a pathful resource.
    expect(audienceMatches('https://h', resource)).toBe(false);
  });

  it('does not match a bare-origin audience with a trailing slash', () => {
    expect(audienceMatches('https://h/', resource)).toBe(false);
  });

  it('does not match a sibling path audience', () => {
    expect(audienceMatches('https://h/api', resource)).toBe(false);
  });

  it('does not treat a partial path segment as a prefix', () => {
    // aud `/mc` must not cover `/mcp`
    expect(audienceMatches('https://h/mc', resource)).toBe(false);
  });

  it('does not match when the audience path is deeper than the resource', () => {
    expect(audienceMatches('https://h/mcp/sub', resource)).toBe(false);
  });

  it('does not match a different origin', () => {
    expect(audienceMatches('https://other/mcp', resource)).toBe(false);
  });

  it('does not match a different port', () => {
    expect(audienceMatches('https://h:8443/mcp', resource)).toBe(false);
  });

  // --- Exact match after canonicalization ---

  it('matches an audience differing only by host case and trailing slash', () => {
    expect(audienceMatches('https://H/mcp/', resource)).toBe(true);
  });

  it('matches an audience differing only by scheme case', () => {
    expect(audienceMatches('HTTPS://h/mcp', resource)).toBe(true);
  });

  it('matches an audience differing only by a fragment', () => {
    expect(audienceMatches('https://h/mcp#frag', resource)).toBe(true);
  });

  it('does not canonicalize away path case differences', () => {
    expect(audienceMatches('https://h/MCP', resource)).toBe(false);
  });

  // --- Array aud ---

  it('matches when any array entry covers the resource', () => {
    expect(audienceMatches(['https://other', 'https://h/mcp'], resource)).toBe(true);
  });

  it('does not match when no array entry covers the resource', () => {
    expect(audienceMatches(['https://other', 'https://h/api'], resource)).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(audienceMatches([], resource)).toBe(false);
  });

  it('skips non-string entries but still matches a later string entry', () => {
    expect(audienceMatches([42, null, undefined, {}, 'https://h/mcp'], resource)).toBe(true);
  });

  // --- Missing / malformed aud ---

  it('returns false for undefined aud', () => {
    expect(audienceMatches(undefined, resource)).toBe(false);
  });

  it('returns false for null aud', () => {
    expect(audienceMatches(null, resource)).toBe(false);
  });

  it('returns false for a non-string aud', () => {
    expect(audienceMatches(123, resource)).toBe(false);
  });

  it('returns false for an empty-string aud', () => {
    expect(audienceMatches('', resource)).toBe(false);
  });

  it('returns false for an array of only non-string entries', () => {
    expect(audienceMatches([1, true, {}, null], resource)).toBe(false);
  });

  // --- Non-URL audiences fall back to exact string equality ---

  it('matches a non-URL aud entry that equals the resource exactly', () => {
    expect(audienceMatches('my-api', 'my-api')).toBe(true);
  });

  it('does not match a non-URL aud entry that differs from the resource', () => {
    expect(audienceMatches('my-api', resource)).toBe(false);
  });

  it('does not match a URL aud against a non-URL resource', () => {
    // new URL(resource) throws first, falling back to exact equality
    expect(audienceMatches('https://h/mcp', 'my-api')).toBe(false);
  });
});
