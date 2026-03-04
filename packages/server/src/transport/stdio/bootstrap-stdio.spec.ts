import 'reflect-metadata';
import { MCP_OPTIONS } from '@nest-mcp/common';
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

function makeMockContext(mcpOptions?: unknown) {
  return {
    close: vi.fn(),
    get: vi.fn().mockImplementation((token: unknown) => {
      if (token === MCP_OPTIONS) {
        if (!mcpOptions) throw new Error('MCP_OPTIONS not found');
        return mcpOptions;
      }
      throw new Error(`Unknown token: ${String(token)}`);
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('bootstrapStdioApp()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls NestFactory.createApplicationContext with the provided module', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    const FakeModule = makeFakeModule();
    await bootstrapStdioApp(FakeModule);
    expect(NestFactory.createApplicationContext).toHaveBeenCalledWith(
      FakeModule,
      expect.objectContaining({}),
    );
  });

  it('passes a StderrLogger instance as the logger', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule());
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    expect((opts as { logger: unknown }).logger).toBeInstanceOf(StderrLogger);
  });

  it('sets bufferLogs to false', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule());
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    expect((opts as { bufferLogs: boolean }).bufferLogs).toBe(false);
  });

  it('returns the application context returned by NestFactory', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    const result = await bootstrapStdioApp(makeFakeModule());
    expect(result).toBe(ctx);
  });

  it('forwards logLevels option to StderrLogger', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule(), { logLevels: ['error', 'warn'] });
    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    const logger = (opts as { logger: StderrLogger }).logger;
    expect(logger).toBeInstanceOf(StderrLogger);
  });

  it('works without options argument', async () => {
    const ctx = makeMockContext();
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await expect(bootstrapStdioApp(makeFakeModule())).resolves.not.toThrow();
  });

  // ─── Logging fallback from MCP_OPTIONS ─────────────────────────────────

  it('applies MCP_OPTIONS.logging as fallback when logLevels is not provided', async () => {
    const ctx = makeMockContext({ logging: ['error', 'warn'] });
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule());

    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    const logger = (opts as { logger: StderrLogger }).logger;

    // Verify setLogLevels was called by checking the logger filters correctly
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.log('should be filtered out');
    logger.error('should pass through');
    logger.warn('should pass through');
    logger.debug('should be filtered out');

    const output = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(output.some((l) => l.includes('ERROR'))).toBe(true);
    expect(output.some((l) => l.includes('WARN'))).toBe(true);
    expect(output.some((l) => l.includes(' LOG '))).toBe(false);
    expect(output.some((l) => l.includes('DEBUG'))).toBe(false);

    stderrSpy.mockRestore();
  });

  it('suppresses all logging when MCP_OPTIONS.logging is false', async () => {
    const ctx = makeMockContext({ logging: false });
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule());

    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    const logger = (opts as { logger: StderrLogger }).logger;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.log('hidden');
    logger.error('hidden');
    logger.warn('hidden');

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('does not override explicit logLevels with MCP_OPTIONS.logging', async () => {
    const ctx = makeMockContext({ logging: false });
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await bootstrapStdioApp(makeFakeModule(), { logLevels: ['error'] });

    const [, opts] = vi.mocked(NestFactory.createApplicationContext).mock.calls[0];
    const logger = (opts as { logger: StderrLogger }).logger;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logger.error('should pass');
    logger.warn('should be filtered');

    const output = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(output.some((l) => l.includes('ERROR'))).toBe(true);
    expect(output.some((l) => l.includes('WARN'))).toBe(false);

    stderrSpy.mockRestore();
  });

  it('gracefully handles missing MCP_OPTIONS token', async () => {
    const ctx = makeMockContext(); // throws on get(MCP_OPTIONS)
    vi.mocked(NestFactory.createApplicationContext).mockResolvedValue(ctx as never);

    await expect(bootstrapStdioApp(makeFakeModule())).resolves.not.toThrow();
  });
});
