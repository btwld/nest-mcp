import type { LogLevel, LoggerService } from '@nestjs/common';

const LEVEL_LABEL: Record<LogLevel, string> = {
  log: 'LOG',
  error: 'ERROR',
  warn: 'WARN',
  debug: 'DEBUG',
  verbose: 'VERBOSE',
  fatal: 'FATAL',
};

/**
 * A NestJS LoggerService that writes all output to process.stderr.
 *
 * Use this when running an MCP server over STDIO transport.
 * The MCP protocol reserves stdout exclusively for JSON-RPC messages;
 * any log output on stdout corrupts the protocol stream.
 *
 * @example
 * // Standalone STDIO app
 * const app = await NestFactory.createApplicationContext(AppModule, {
 *   logger: new StderrLogger(),
 * });
 *
 * // Mixed HTTP + STDIO app
 * const app = await NestFactory.create(AppModule, {
 *   logger: new StderrLogger(),
 * });
 */
export class StderrLogger implements LoggerService {
  private readonly levels: Set<LogLevel>;

  constructor(options?: { logLevels?: LogLevel[] }) {
    this.levels = new Set(options?.logLevels ?? ['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
  }

  private write(level: LogLevel, message: unknown, context?: string): void {
    if (!this.levels.has(level)) return;
    const label = LEVEL_LABEL[level];
    const ts = new Date().toISOString();
    const ctx = context ? ` [${context}]` : '';
    process.stderr.write(`${ts} ${label}${ctx} ${String(message)}\n`);
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context);
    if (trace) {
      process.stderr.write(`${trace}\n`);
    }
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.levels.clear();
    for (const level of levels) {
      this.levels.add(level);
    }
  }
}
