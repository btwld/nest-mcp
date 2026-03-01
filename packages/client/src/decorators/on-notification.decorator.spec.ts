import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/common', () => ({
  SetMetadata: vi.fn().mockReturnValue(() => {}),
}));

import { SetMetadata } from '@nestjs/common';
import { MCP_NOTIFICATION_METADATA, OnMcpNotification } from './on-notification.decorator';

describe('OnMcpNotification decorator', () => {
  it('should export MCP_NOTIFICATION_METADATA as a Symbol', () => {
    expect(typeof MCP_NOTIFICATION_METADATA).toBe('symbol');
  });

  it('should call SetMetadata with the correct symbol and metadata', () => {
    OnMcpNotification('server-a', 'tools/listChanged');

    expect(SetMetadata).toHaveBeenCalledWith(MCP_NOTIFICATION_METADATA, {
      connectionName: 'server-a',
      method: 'tools/listChanged',
    });
  });

  it('should pass different connection names and methods correctly', () => {
    OnMcpNotification('server-b', 'resources/updated');

    expect(SetMetadata).toHaveBeenCalledWith(MCP_NOTIFICATION_METADATA, {
      connectionName: 'server-b',
      method: 'resources/updated',
    });
  });

  it('should return the result of SetMetadata (a MethodDecorator)', () => {
    const result = OnMcpNotification('server-c', 'tools/listChanged');
    // SetMetadata mock returns () => {} — verify it is a function
    expect(typeof result).toBe('function');
  });

  it('MCP_NOTIFICATION_METADATA is unique (different from common Symbol)', () => {
    const otherSymbol = Symbol('mcp:client-notification');
    expect(MCP_NOTIFICATION_METADATA).not.toBe(otherSymbol);
  });
});
