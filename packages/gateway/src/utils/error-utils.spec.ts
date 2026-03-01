import { extractErrorMessage } from './error-utils';

describe('extractErrorMessage', () => {
  it('should extract message from Error instances', () => {
    expect(extractErrorMessage(new Error('something failed'))).toBe('something failed');
  });

  it('should convert strings to string', () => {
    expect(extractErrorMessage('raw string error')).toBe('raw string error');
  });

  it('should convert numbers to string', () => {
    expect(extractErrorMessage(42)).toBe('42');
  });

  it('should convert null to string', () => {
    expect(extractErrorMessage(null)).toBe('null');
  });

  it('should convert undefined to string', () => {
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('should convert objects to string', () => {
    expect(extractErrorMessage({ code: 500 })).toBe('[object Object]');
  });

  it('should convert boolean true to string', () => {
    expect(extractErrorMessage(true)).toBe('true');
  });

  it('should use message property from Error subclasses', () => {
    const err = new TypeError('type mismatch');
    expect(extractErrorMessage(err)).toBe('type mismatch');
  });
});
