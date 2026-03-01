import { describe, expect, it } from 'vitest';
import {
  MCP_FEATURE_REGISTRATION,
  nextFeatureRegistrationToken,
} from './feature-registration.constants';

describe('MCP_FEATURE_REGISTRATION', () => {
  it('is a non-empty string constant', () => {
    expect(typeof MCP_FEATURE_REGISTRATION).toBe('string');
    expect(MCP_FEATURE_REGISTRATION.length).toBeGreaterThan(0);
  });
});

describe('nextFeatureRegistrationToken()', () => {
  it('returns a string', () => {
    expect(typeof nextFeatureRegistrationToken()).toBe('string');
  });

  it('tokens start with MCP_FEATURE_REGISTRATION prefix', () => {
    const token = nextFeatureRegistrationToken();
    expect(token.startsWith(MCP_FEATURE_REGISTRATION)).toBe(true);
  });

  it('each call returns a unique token', () => {
    const t1 = nextFeatureRegistrationToken();
    const t2 = nextFeatureRegistrationToken();
    const t3 = nextFeatureRegistrationToken();
    expect(t1).not.toBe(t2);
    expect(t2).not.toBe(t3);
  });

  it('tokens are monotonically increasing (suffix grows)', () => {
    const t1 = nextFeatureRegistrationToken();
    const t2 = nextFeatureRegistrationToken();
    const suffix1 = Number(t1.split('_').pop());
    const suffix2 = Number(t2.split('_').pop());
    expect(suffix2).toBeGreaterThan(suffix1);
  });
});
