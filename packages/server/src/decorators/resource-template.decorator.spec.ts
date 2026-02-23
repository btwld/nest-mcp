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
});
