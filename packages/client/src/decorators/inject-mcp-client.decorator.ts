import { Inject } from '@nestjs/common';

export function getMcpClientToken(name: string): string {
  return `MCP_CLIENT_${name}`;
}

export function InjectMcpClient(name: string): ParameterDecorator {
  return Inject(getMcpClientToken(name));
}
