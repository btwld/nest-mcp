import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/common', () => ({
  Inject: vi.fn().mockReturnValue(() => {}),
}));

import { Inject } from '@nestjs/common';
import { InjectMcpClient, getMcpClientToken } from './inject-mcp-client.decorator';

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

    it('should return the result of Inject (a ParameterDecorator)', () => {
      const result = InjectMcpClient('server');
      expect(typeof result).toBe('function');
    });
  });

  describe('getMcpClientToken edge cases', () => {
    it('should handle empty string name', () => {
      expect(getMcpClientToken('')).toBe('MCP_CLIENT_');
    });

    it('should return a string type', () => {
      expect(typeof getMcpClientToken('my-server')).toBe('string');
    });
  });
});
