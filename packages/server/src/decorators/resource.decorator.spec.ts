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

  it('stores title when provided', () => {
    class TestService {
      @Resource({ uri: 'file:///docs.txt', title: 'Documentation' })
      getDocs() {
        return '';
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getDocs');
    expect(metadata.title).toBe('Documentation');
  });

  it('does not include title key when title is not provided', () => {
    class TestService {
      @Resource({ uri: 'file:///data.txt' })
      getData() {
        return '';
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getData');
    expect('title' in metadata).toBe(false);
  });

  it('stores icons when provided', () => {
    const icons = [{ uri: 'https://example.com/icon.png' }];

    class TestService {
      @Resource({ uri: 'file:///items.json', icons })
      getItems() {
        return '[]';
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getItems');
    expect(metadata.icons).toBe(icons);
  });

  it('stores _meta when provided', () => {
    const _meta = { version: '1.0' };

    class TestService {
      @Resource({ uri: 'file:///meta.json', _meta })
      getMeta() {
        return '{}';
      }
    }

    const metadata = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getMeta');
    expect(metadata._meta).toBe(_meta);
  });

  it('stores independent metadata per method on same class', () => {
    class TestService {
      @Resource({ uri: 'file:///a.txt', name: 'resource-a' })
      getA() {
        return 'a';
      }

      @Resource({ uri: 'file:///b.txt', name: 'resource-b' })
      getB() {
        return 'b';
      }
    }

    const metaA = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getA');
    const metaB = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'getB');

    expect(metaA.name).toBe('resource-a');
    expect(metaA.uri).toBe('file:///a.txt');
    expect(metaB.name).toBe('resource-b');
    expect(metaB.uri).toBe('file:///b.txt');
  });

  it('does not affect other methods without the decorator', () => {
    class TestService {
      @Resource({ uri: 'file:///only.txt' })
      decorated() {
        return '';
      }

      undecorated() {
        return '';
      }
    }

    const meta = Reflect.getMetadata(MCP_RESOURCE_METADATA, TestService.prototype, 'undecorated');
    expect(meta).toBeUndefined();
  });
});
