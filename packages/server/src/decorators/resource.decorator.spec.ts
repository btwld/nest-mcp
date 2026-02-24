import 'reflect-metadata';
import { MCP_RESOURCE_METADATA } from '@btwld/mcp-common';
import { Resource } from './resource.decorator';

describe('Resource decorator', () => {
  it('stores ResourceMetadata with uri, name, description, mimeType', () => {
    class TestService {
      @Resource({
        uri: 'file:///config.json',
        name: 'config',
        description: 'App configuration',
        mimeType: 'application/json',
      })
      getConfig() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getConfig');

    expect(metadata).toBeDefined();
    expect(metadata.uri).toBe('file:///config.json');
    expect(metadata.name).toBe('config');
    expect(metadata.description).toBe('App configuration');
    expect(metadata.mimeType).toBe('application/json');
    expect(metadata.methodName).toBe('getConfig');
    expect(metadata.target).toBe(TestService);
  });

  it('defaults name to propertyKey when not provided', () => {
    class TestService {
      @Resource({ uri: 'file:///data.txt' })
      readData() {
        return 'data';
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'readData');

    expect(metadata.name).toBe('readData');
    expect(metadata.uri).toBe('file:///data.txt');
  });
});
