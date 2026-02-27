import type { DynamicModule, INestApplicationContext, LogLevel, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StderrLogger } from './stderr-logger';

export interface StdioBootstrapOptions {
  /** Log levels to emit. Defaults to all levels. */
  logLevels?: LogLevel[];
}

/**
 * Bootstraps a standalone NestJS application context for STDIO MCP transport.
 *
 * Automatically redirects all NestJS logging to stderr so that stdout remains
 * reserved for JSON-RPC messages. Calling `NestFactory.create()` or
 * `createApplicationContext()` without this helper risks corrupting the STDIO
 * protocol stream with log output.
 *
 * @example
 * async function main() {
 *   const app = await bootstrapStdioApp(AppModule);
 *   await app.get(StdioService).start();
 * }
 * main().catch(console.error);
 */
export async function bootstrapStdioApp(
  module: Type<unknown> | DynamicModule,
  options?: StdioBootstrapOptions,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, {
    logger: new StderrLogger(options),
    bufferLogs: false,
  });
}
