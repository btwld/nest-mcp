import type {
  McpAuthenticatedUser,
  McpExecutionContext,
  McpProgress,
  McpSamplingParams,
  McpSamplingResult,
  McpTransportType,
} from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSamplingContent } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class McpContextFactory {
  createContext(options: {
    sessionId: string;
    transport: McpTransportType;
    request?: unknown;
    user?: McpAuthenticatedUser;
    progressCallback?: (progress: McpProgress) => Promise<void>;
    signal?: AbortSignal;
    mcpServer?: McpServer;
    notifyResourceUpdated?: (uri: string) => Promise<void>;
  }): McpExecutionContext {
    const logger = new Logger(`MCP:${options.sessionId.slice(0, 8)}`);
    const loggerName = `MCP:${options.sessionId.slice(0, 8)}`;
    const server = options.mcpServer;

    return {
      sessionId: options.sessionId,
      transport: options.transport,
      request: options.request,
      user: options.user,
      metadata: {},
      signal: options.signal,
      reportProgress: options.progressCallback ?? (async () => {}),
      ...(options.notifyResourceUpdated
        ? { notifyResourceUpdated: options.notifyResourceUpdated }
        : {}),
      ...(server
        ? {
            createMessage: async (params: McpSamplingParams): Promise<McpSamplingResult> => {
              if (!server.server.getClientCapabilities()?.sampling) {
                throw new Error('Connected client does not support sampling');
              }
              const result = await server.server.createMessage(params);
              return {
                role: result.role,
                content: result.content as McpSamplingContent,
                model: result.model,
                stopReason: result.stopReason,
              };
            },
          }
        : {}),
      log: {
        debug: (message, data) => {
          logger.debug(message, data);
          server
            ?.sendLoggingMessage({
              level: 'debug',
              logger: loggerName,
              data: data ? { message, ...data } : message,
            })
            .catch(() => {});
        },
        info: (message, data) => {
          logger.log(message, data);
          server
            ?.sendLoggingMessage({
              level: 'info',
              logger: loggerName,
              data: data ? { message, ...data } : message,
            })
            .catch(() => {});
        },
        warn: (message, data) => {
          logger.warn(message, data);
          server
            ?.sendLoggingMessage({
              level: 'warning',
              logger: loggerName,
              data: data ? { message, ...data } : message,
            })
            .catch(() => {});
        },
        error: (message, data) => {
          logger.error(message, data);
          server
            ?.sendLoggingMessage({
              level: 'error',
              logger: loggerName,
              data: data ? { message, ...data } : message,
            })
            .catch(() => {});
        },
      },
    };
  }
}
