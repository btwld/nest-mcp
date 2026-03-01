import { matchGlobPattern } from './pattern-matcher';

describe('matchGlobPattern', () => {
  it('should match exact names', () => {
    expect(matchGlobPattern('myTool', 'myTool')).toBe(true);
    expect(matchGlobPattern('myTool', 'otherTool')).toBe(false);
  });

  it('should match wildcard (*) patterns', () => {
    expect(matchGlobPattern('gh_listRepos', 'gh_*')).toBe(true);
    expect(matchGlobPattern('gh_createRepo', 'gh_*')).toBe(true);
    expect(matchGlobPattern('slack_send', 'gh_*')).toBe(false);
  });

  it('should match single-char (?) patterns', () => {
    expect(matchGlobPattern('tool_a', 'tool_?')).toBe(true);
    expect(matchGlobPattern('tool_ab', 'tool_?')).toBe(false);
  });

  it('should match all with standalone wildcard', () => {
    expect(matchGlobPattern('anything', '*')).toBe(true);
  });

  it('should escape regex special characters', () => {
    expect(matchGlobPattern('my.tool', 'my.tool')).toBe(true);
    expect(matchGlobPattern('myXtool', 'my.tool')).toBe(false);
  });

  it('should use cached regex on repeated calls', () => {
    // Call twice with same pattern to exercise cache path
    expect(matchGlobPattern('a', 'a*')).toBe(true);
    expect(matchGlobPattern('ab', 'a*')).toBe(true);
  });

  it('should handle complex patterns', () => {
    expect(matchGlobPattern('prefix_tool_action', 'prefix_*_action')).toBe(true);
    expect(matchGlobPattern('prefix_tool_other', 'prefix_*_action')).toBe(false);
  });

  it('should not match partial names when no wildcard is used', () => {
    expect(matchGlobPattern('myToolExtra', 'myTool')).toBe(false);
    expect(matchGlobPattern('prefixmyTool', 'myTool')).toBe(false);
  });

  it('should match empty string with standalone wildcard', () => {
    expect(matchGlobPattern('', '*')).toBe(true);
  });

  it('should handle multiple ? placeholders', () => {
    expect(matchGlobPattern('ab', '??')).toBe(true);
    expect(matchGlobPattern('abc', '??')).toBe(false);
  });
});
