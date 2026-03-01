import type { Type } from '@nestjs/common';

export const MCP_FEATURE_REGISTRATION = 'MCP_FEATURE_REGISTRATION';

export interface McpFeatureRegistration {
  serverName: string;
  providerTokens: Type[];
}

let featureIdCounter = 0;
export function nextFeatureRegistrationToken(): string {
  return `${MCP_FEATURE_REGISTRATION}_${featureIdCounter++}`;
}
