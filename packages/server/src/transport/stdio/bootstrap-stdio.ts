import type { McpModuleOptions } from '@nest-mcp/common';
import { MCP_OPTIONS } from '@nest-mcp/common';
import type { DynamicModule, INestApplicationContext, LogLevel, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StderrLogger } from './stderr-logger';

export interface StdioBootstrapOptions {
  /** Log levels to emit. Defaults to all levels. */
  logLevels?: LogLevel[];
}

/** Reads `McpModuleOptions.logging` from DI, returning `undefined` when unavailable. */
function resolveLoggingFromModule(app: INestApplicationContext): LogLevel[] | false | undefined {
  try {
    return app.get<McpModuleOptions>(MCP_OPTIONS).logging;
  } catch {
    return undefined;
  }
}

/**
 * Bootstraps a standalone NestJS application context for STDIO MCP transport.
 *
 * Automatically redirects all NestJS logging to stderr so that stdout remains
 * reserved for JSON-RPC messages. Calling `NestFactory.create()` or
 * `createApplicationContext()` without this helper risks corrupting the STDIO
 * protocol stream with log output.
 *
 * Log-level filtering priority:
 * 1. `StdioBootstrapOptions.logLevels` (explicit caller override)
 * 2. `McpModuleOptions.logging` (from `McpModule.forRoot()`)
 * 3. All levels (default)
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
  const logger = new StderrLogger(options);

  const app = await NestFactory.createApplicationContext(module, {
    logger,
    bufferLogs: false,
  });

  if (!options?.logLevels) {
    const logging = resolveLoggingFromModule(app);
    if (logging !== undefined) {
      logger.setLogLevels(logging === false ? [] : logging);
    }
  }

  return app;
}
