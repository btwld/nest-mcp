import 'reflect-metadata';
import { MCP_RESOURCE_TEMPLATE_METADATA } from '@btwld/mcp-common';
import { ResourceTemplate } from './resource-template.decorator';

describe('ResourceTemplate decorator', () => {
  it('stores ResourceTemplateMetadata with uriTemplate, name, description, mimeType', () => {
    class TestService {
      @ResourceTemplate({
        uriTemplate: 'file:///users/{userId}/profile',
        name: 'user-profile',
        description: 'User profile resource',
        mimeType: 'application/json',
      })
      getUserProfile() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getUserProfile',
    );

    expect(metadata).toBeDefined();
    expect(metadata.uriTemplate).toBe('file:///users/{userId}/profile');
    expect(metadata.name).toBe('user-profile');
    expect(metadata.description).toBe('User profile resource');
    expect(metadata.mimeType).toBe('application/json');
    expect(metadata.methodName).toBe('getUserProfile');
    expect(metadata.target).toBe(TestService);
  });

  it('defaults name to propertyKey when not provided', () => {
    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///items/{id}' })
      getItem() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getItem',
    );

    expect(metadata.name).toBe('getItem');
    expect(metadata.uriTemplate).toBe('file:///items/{id}');
  });

  it('stores title when provided', () => {
    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///docs/{id}', title: 'Document' })
      getDoc() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getDoc',
    );
    expect(metadata.title).toBe('Document');
  });

  it('does not include title key when title is not provided', () => {
    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///items/{id}' })
      listItem() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'listItem',
    );
    expect('title' in metadata).toBe(false);
  });

  it('stores icons when provided', () => {
    const icons = [{ uri: 'https://example.com/icon.png' }];

    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///files/{path}', icons })
      getFile() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getFile',
    );
    expect(metadata.icons).toBe(icons);
  });

  it('stores _meta when provided', () => {
    const _meta = { category: 'user-data' };

    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///users/{id}', _meta })
      getUser() {
        return {};
      }
    }

    const metadata = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getUser',
    );
    expect(metadata._meta).toBe(_meta);
  });

  it('stores independent metadata per method on same class', () => {
    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///users/{id}', name: 'user-template' })
      getUser() {
        return {};
      }

      @ResourceTemplate({ uriTemplate: 'file:///posts/{id}', name: 'post-template' })
      getPost() {
        return {};
      }
    }

    const userMeta = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getUser',
    );
    const postMeta = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'getPost',
    );

    expect(userMeta.name).toBe('user-template');
    expect(postMeta.name).toBe('post-template');
  });

  it('does not affect other methods without the decorator', () => {
    class TestService {
      @ResourceTemplate({ uriTemplate: 'file:///only/{id}' })
      decorated() {
        return {};
      }

      undecorated() {
        return {};
      }
    }

    const meta = Reflect.getMetadata(
      MCP_RESOURCE_TEMPLATE_METADATA,
      TestService.prototype,
      'undecorated',
    );
    expect(meta).toBeUndefined();
  });
});
