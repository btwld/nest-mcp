import { MockMcpClient, getMcpClientToken } from '@btwld/mcp-client';
import { Test } from '@nestjs/testing';
import { AppService } from './app.service';

describe('AppService (with MockMcpClient)', () => {
  let service: AppService;
  let playgroundMock: MockMcpClient;
  let sseMock: MockMcpClient;
  let stdioMock: MockMcpClient;

  beforeEach(async () => {
    playgroundMock = new MockMcpClient('playground');
    sseMock = new MockMcpClient('sse-server');
    stdioMock = new MockMcpClient('stdio-server');
    await playgroundMock.connect();
    await sseMock.connect();
    await stdioMock.connect();

    const module = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: getMcpClientToken('playground'),
          useValue: playgroundMock,
        },
        {
          provide: getMcpClientToken('sse-server'),
          useValue: sseMock,
        },
        {
          provide: getMcpClientToken('stdio-server'),
          useValue: stdioMock,
        },
        {
          provide: 'MCP_CLIENT_CONNECTIONS',
          useValue: [playgroundMock, sseMock, stdioMock],
        },
      ],
    }).compile();

    service = module.get(AppService);
  });

  describe('listTools', () => {
    it('should return tools from the playground client', async () => {
      playgroundMock.setListToolsResult({
        tools: [
          { name: 'get_weather', description: 'Get weather data', inputSchema: { type: 'object' } },
          { name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } },
        ],
      });

      const result = await service.listTools();
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe('get_weather');
    });
  });

  describe('callTool', () => {
    it('should forward tool calls to the playground client', async () => {
      playgroundMock.setCallToolResult({
        content: [{ type: 'text', text: 'Temperature in Paris: 22°C' }],
      });

      const result = await service.callTool('get_weather', { city: 'Paris' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Temperature in Paris: 22°C',
      });
    });
  });

  describe('listResources', () => {
    it('should return resources from the playground client', async () => {
      playgroundMock.setListResourcesResult({
        resources: [
          { uri: 'config://app', name: 'App Configuration', mimeType: 'application/json' },
        ],
      });

      const result = await service.listResources();
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].uri).toBe('config://app');
    });
  });

  describe('listPrompts', () => {
    it('should return prompts from the playground client', async () => {
      playgroundMock.setListPromptsResult({
        prompts: [{ name: 'code_review', description: 'Review code for best practices' }],
      });

      const result = await service.listPrompts();
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].name).toBe('code_review');
    });
  });

  describe('listAllTools (multi-client)', () => {
    it('should aggregate tools from all connected clients', async () => {
      playgroundMock.setListToolsResult({
        tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }],
      });
      sseMock.setListToolsResult({
        tools: [{ name: 'sse_echo', description: 'SSE Echo', inputSchema: { type: 'object' } }],
      });
      stdioMock.setListToolsResult({
        tools: [{ name: 'calculate', description: 'Calculate', inputSchema: { type: 'object' } }],
      });

      const result = await service.listAllTools();
      expect(result).toHaveLength(3);
      expect(result[0].connection).toBe('playground');
      expect(result[0].tools).toHaveLength(1);
      expect(result[1].connection).toBe('sse-server');
      expect(result[1].tools).toHaveLength(1);
      expect(result[2].connection).toBe('stdio-server');
      expect(result[2].tools).toHaveLength(1);
    });

    it('should handle errors from individual clients gracefully', async () => {
      playgroundMock.setListToolsResult({
        tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }],
      });
      // Make the SSE mock throw by overriding listTools
      sseMock.listTools = async () => {
        throw new Error('Connection lost');
      };
      stdioMock.setListToolsResult({
        tools: [{ name: 'calculate', description: 'Calculate', inputSchema: { type: 'object' } }],
      });

      const result = await service.listAllTools();
      expect(result).toHaveLength(3);
      expect(result[0].tools).toHaveLength(1);
      expect(result[1].error).toBe('Connection lost');
      expect(result[1].tools).toHaveLength(0);
      expect(result[2].tools).toHaveLength(1);
    });
  });

  describe('getConnectionStatus', () => {
    it('should return status for all clients', () => {
      const result = service.getConnectionStatus();
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('playground');
      expect(result[0].connected).toBe(true);
      expect(result[1].name).toBe('sse-server');
      expect(result[1].connected).toBe(true);
      expect(result[2].name).toBe('stdio-server');
      expect(result[2].connected).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return playground connection status', () => {
      const result = service.getStatus();
      expect(result.connected).toBe(true);
      expect(result.serverCapabilities).toBeUndefined();
      expect(result.serverVersion).toBeUndefined();
    });
  });

  describe('SSE server operations', () => {
    it('should list tools from the SSE server', async () => {
      sseMock.setListToolsResult({
        tools: [{ name: 'sse_echo', description: 'SSE Echo', inputSchema: { type: 'object' } }],
      });

      const result = await service.listSseTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('sse_echo');
    });

    it('should list resources from the SSE server', async () => {
      sseMock.setListResourcesResult({
        resources: [{ uri: 'sse://data', name: 'SSE Data' }],
      });

      const result = await service.listSseResources();
      expect(result.resources).toHaveLength(1);
    });
  });

  describe('Stdio server operations', () => {
    it('should list tools from the stdio server', async () => {
      stdioMock.setListToolsResult({
        tools: [
          {
            name: 'calculate',
            description: 'Calculate expressions',
            inputSchema: { type: 'object' },
          },
          { name: 'convert_units', description: 'Convert units', inputSchema: { type: 'object' } },
        ],
      });

      const result = await service.listStdioTools();
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe('calculate');
      expect(result.tools[1].name).toBe('convert_units');
    });

    it('should call a tool on the stdio server', async () => {
      stdioMock.setCallToolResult({
        content: [{ type: 'text', text: '42' }],
      });

      const result = await service.callStdioTool('calculate', { expression: '6 * 7' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: '42' });
    });

    it('should list resources from the stdio server', async () => {
      stdioMock.setListResourcesResult({
        resources: [{ uri: 'stdio://data', name: 'Stdio Data' }],
      });

      const result = await service.listStdioResources();
      expect(result.resources).toHaveLength(1);
    });

    it('should list prompts from the stdio server', async () => {
      stdioMock.setListPromptsResult({
        prompts: [{ name: 'math_helper', description: 'Help with math' }],
      });

      const result = await service.listStdioPrompts();
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].name).toBe('math_helper');
    });
  });
});
