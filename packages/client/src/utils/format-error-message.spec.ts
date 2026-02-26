import { formatErrorMessage } from './format-error-message';

describe('formatErrorMessage', () => {
  it('should extract message from Error instances', () => {
    expect(formatErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('should convert strings to string', () => {
    expect(formatErrorMessage('raw error')).toBe('raw error');
  });

  it('should convert numbers to string', () => {
    expect(formatErrorMessage(404)).toBe('404');
  });

  it('should convert null to string', () => {
    expect(formatErrorMessage(null)).toBe('null');
  });

  it('should convert undefined to string', () => {
    expect(formatErrorMessage(undefined)).toBe('undefined');
  });
});
