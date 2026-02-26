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
});
