import { SetMetadata } from '@nestjs/common';

export const MCP_NOTIFICATION_METADATA = Symbol('mcp:client-notification');

export interface McpNotificationMetadata {
  connectionName: string;
  method: string;
}

export function OnMcpNotification(connectionName: string, method: string): MethodDecorator {
  return SetMetadata(MCP_NOTIFICATION_METADATA, {
    connectionName,
    method,
  } satisfies McpNotificationMetadata);
}
