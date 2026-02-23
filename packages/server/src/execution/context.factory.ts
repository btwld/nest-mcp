import { Injectable, Logger } from '@nestjs/common';
import type { McpExecutionContext, McpProgress, McpTransportType } from '@btwld/mcp-common';

@Injectable()
export class McpContextFactory {
  createContext(options: {
    sessionId: string;
    transport: McpTransportType;
    request?: unknown;
    user?: any;
    progressCallback?: (progress: McpProgress) => Promise<void>;
    signal?: AbortSignal;
  }): McpExecutionContext {
    const logger = new Logger(`MCP:${options.sessionId.slice(0, 8)}`);

    return {
      sessionId: options.sessionId,
      transport: options.transport,
      request: options.request,
      user: options.user,
      metadata: {},
      signal: options.signal,
      reportProgress: options.progressCallback ?? (async () => {}),
      log: {
        debug: (message, data) => logger.debug(message, data),
        info: (message, data) => logger.log(message, data),
        warn: (message, data) => logger.warn(message, data),
        error: (message, data) => logger.error(message, data),
      },
    };
  }
}
