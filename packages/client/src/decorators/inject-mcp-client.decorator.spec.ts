import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/common', () => ({
  Inject: vi.fn().mockReturnValue(() => {}),
}));

import { getMcpClientToken, InjectMcpClient } from './inject-mcp-client.decorator';
import { Inject } from '@nestjs/common';

describe('InjectMcpClient decorator', () => {
  describe('getMcpClientToken', () => {
    it('should return a token with MCP_CLIENT_ prefix', () => {
      expect(getMcpClientToken('github')).toBe('MCP_CLIENT_github');
    });

    it('should include the exact name provided', () => {
      expect(getMcpClientToken('my-server')).toBe('MCP_CLIENT_my-server');
    });

    it('should return different tokens for different names', () => {
      expect(getMcpClientToken('a')).not.toBe(getMcpClientToken('b'));
    });
  });

  describe('InjectMcpClient', () => {
    it('should call Inject with the correct token', () => {
      InjectMcpClient('github');
      expect(Inject).toHaveBeenCalledWith('MCP_CLIENT_github');
    });
  });
});
