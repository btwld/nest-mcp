vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ type: 'stdio' })),
}));

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStdioTransport } from './stdio-client.transport';

describe('createStdioTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create StdioClientTransport with command only', () => {
    createStdioTransport({
      name: 'test',
      transport: 'stdio',
      command: 'node',
    });

    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: 'node',
      args: undefined,
      env: undefined,
      cwd: undefined,
    });
  });

  it('should pass all options to StdioClientTransport', () => {
    createStdioTransport({
      name: 'test',
      transport: 'stdio',
      command: 'python',
      args: ['-m', 'mcp_server'],
      env: { NODE_ENV: 'production' },
      cwd: '/app',
    });

    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: 'python',
      args: ['-m', 'mcp_server'],
      env: { NODE_ENV: 'production' },
      cwd: '/app',
    });
  });

  it('should return the created transport', () => {
    const transport = createStdioTransport({
      name: 'test',
      transport: 'stdio',
      command: 'node',
    });

    expect(transport).toEqual({ type: 'stdio' });
  });
});
