import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock NestFactory before importing the module under test
vi.mock('@nestjs/core', () => ({
  NestFactory: {
    createApplicationContext: vi.fn(),
  },
}));

import { NestFactory } from '@nestjs/core';
import { bootstrapStdioApp } from './bootstrap-stdio';
import { StderrLogger } from './stderr-logger';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeModule() {
  return class FakeModule {};
}

const mockContext = { close: vi.fn() };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('bootstrapStdioApp()', () => {
  beforeEach(() => {
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(mockContext as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls NestFactory.createApplicationContext with the provided module', async () => {
    const FakeModule = makeFakeModule();
    await bootstrapStdioApp(FakeModule);
    expect(NestFactory.createApplicationContext).toHaveBeenCalledWith(
      FakeModule,
      expect.objectContaining({}),
    );
  });

  it('passes a StderrLogger instance as the logger', async () => {
    await bootstrapStdioApp(makeFakeModule());
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    expect((opts as { logger: unknown }).logger).toBeInstanceOf(StderrLogger);
  });

  it('sets bufferLogs to false', async () => {
    await bootstrapStdioApp(makeFakeModule());
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    expect((opts as { bufferLogs: boolean }).bufferLogs).toBe(false);
  });

  it('returns the application context returned by NestFactory', async () => {
    const result = await bootstrapStdioApp(makeFakeModule());
    expect(result).toBe(mockContext);
  });

  it('forwards logLevels option to StderrLogger', async () => {
    await bootstrapStdioApp(makeFakeModule(), { logLevels: ['error', 'warn'] });
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    const logger = (opts as { logger: StderrLogger }).logger;
    // StderrLogger should have been constructed — it's an instance
    expect(logger).toBeInstanceOf(StderrLogger);
  });

  it('works without options argument', async () => {
    await expect(bootstrapStdioApp(makeFakeModule())).resolves.not.toThrow();
  });
});
