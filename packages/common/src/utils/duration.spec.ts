import { describe, expect, it } from 'vitest';
import { parseDurationMs, parseDurationSeconds } from './duration';

describe('parseDurationMs', () => {
  describe('valid units', () => {
    it('parses seconds (s)', () => {
      expect(parseDurationMs('30s', 0)).toBe(30_000);
    });

    it('parses minutes (m)', () => {
      expect(parseDurationMs('5m', 0)).toBe(300_000);
    });

    it('parses hours (h)', () => {
      expect(parseDurationMs('2h', 0)).toBe(7_200_000);
    });

    it('parses days (d)', () => {
      expect(parseDurationMs('7d', 0)).toBe(604_800_000);
    });

    it('parses single-unit values (1s)', () => {
      expect(parseDurationMs('1s', 0)).toBe(1_000);
    });
  });

  describe('fallback', () => {
    it('returns fallback for empty string', () => {
      expect(parseDurationMs('', 9999)).toBe(9999);
    });

    it('returns fallback for unsupported unit', () => {
      expect(parseDurationMs('10w', 5000)).toBe(5000);
    });

    it('returns fallback for missing number', () => {
      expect(parseDurationMs('m', 1234)).toBe(1234);
    });

    it('returns fallback for bare number with no unit', () => {
      expect(parseDurationMs('60', 42)).toBe(42);
    });

    it('returns fallback for negative values', () => {
      expect(parseDurationMs('-1s', 100)).toBe(100);
    });

    it('returns fallback for decimal values', () => {
      expect(parseDurationMs('1.5m', 0)).toBe(0);
    });
  });
});

describe('parseDurationSeconds', () => {
  describe('valid units', () => {
    it('parses seconds (s) into seconds', () => {
      expect(parseDurationSeconds('30s', 0)).toBe(30);
    });

    it('parses minutes (m) into seconds', () => {
      expect(parseDurationSeconds('5m', 0)).toBe(300);
    });

    it('parses hours (h) into seconds', () => {
      expect(parseDurationSeconds('1h', 0)).toBe(3600);
    });

    it('parses days (d) into seconds', () => {
      expect(parseDurationSeconds('1d', 0)).toBe(86_400);
    });
  });

  describe('fallback', () => {
    it('returns fallback for invalid string', () => {
      expect(parseDurationSeconds('bad', 60)).toBe(60);
    });

    it('returns fallback for empty string', () => {
      expect(parseDurationSeconds('', 30)).toBe(30);
    });
  });

  describe('consistency with parseDurationMs', () => {
    it('parseDurationSeconds result * 1000 equals parseDurationMs result', () => {
      for (const input of ['10s', '2m', '3h', '1d']) {
        expect(parseDurationSeconds(input, 0) * 1000).toBe(parseDurationMs(input, 0));
      }
    });
  });
});
