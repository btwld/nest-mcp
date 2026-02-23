import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/common', () => ({
  SetMetadata: vi.fn().mockReturnValue(() => {}),
}));

import {
  MCP_NOTIFICATION_METADATA,
  OnMcpNotification,
} from './on-notification.decorator';
import { SetMetadata } from '@nestjs/common';

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
});
