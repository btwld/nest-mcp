import 'reflect-metadata';
import { MCP_PROMPT_METADATA } from '@nest-mcp/common';
import { z } from 'zod';
import { Prompt } from './prompt.decorator';

describe('Prompt decorator', () => {
  it('stores PromptMetadata with name, description, and parameters', () => {
    const params = z.object({ topic: z.string(), length: z.number() });

    class TestService {
      @Prompt({
        name: 'summarize',
        description: 'Summarize a topic',
        parameters: params,
      })
      summarize() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'summarize');

    expect(metadata).toBeDefined();
    expect(metadata.name).toBe('summarize');
    expect(metadata.description).toBe('Summarize a topic');
    expect(metadata.parameters).toBe(params);
    expect(metadata.methodName).toBe('summarize');
    expect(metadata.target).toBe(TestService);
  });

  it('defaults name to propertyKey when not provided', () => {
    class TestService {
      @Prompt({ description: 'A greeting prompt' })
      greet() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'greet');

    expect(metadata.name).toBe('greet');
  });

  it('works without parameters', () => {
    class TestService {
      @Prompt({ name: 'simple', description: 'No params prompt' })
      simple() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'simple');

    expect(metadata.name).toBe('simple');
    expect(metadata.description).toBe('No params prompt');
    expect(metadata.parameters).toBeUndefined();
  });

  it('stores title when provided', () => {
    class TestService {
      @Prompt({ description: 'Titled prompt', title: 'My Prompt' })
      titled() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'titled');
    expect(metadata.title).toBe('My Prompt');
  });

  it('does not include title key when title is not provided', () => {
    class TestService {
      @Prompt({ description: 'No title' })
      noTitle() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'noTitle');
    expect('title' in metadata).toBe(false);
  });

  it('stores icons when provided', () => {
    const icons = [{ uri: 'https://example.com/prompt-icon.png' }];

    class TestService {
      @Prompt({ description: 'Icon prompt', icons })
      withIcons() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'withIcons');
    expect(metadata.icons).toBe(icons);
  });

  it('stores independent metadata per method on same class', () => {
    class TestService {
      @Prompt({ name: 'first-prompt', description: 'First' })
      first() {
        return { messages: [] };
      }

      @Prompt({ name: 'second-prompt', description: 'Second' })
      second() {
        return { messages: [] };
      }
    }

    const metaFirst = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'first');
    const metaSecond = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'second');

    expect(metaFirst.name).toBe('first-prompt');
    expect(metaSecond.name).toBe('second-prompt');
  });

  it('stores _meta when provided', () => {
    const _meta = { version: '2.0', category: 'writing' };

    class TestService {
      @Prompt({ description: 'prompt with meta', _meta })
      withMeta() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'withMeta');
    expect(metadata._meta).toBe(_meta);
  });

  it('does not include _meta key when _meta is not provided', () => {
    class TestService {
      @Prompt({ description: 'no meta' })
      noMeta() {
        return { messages: [] };
      }
    }

    const metadata = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'noMeta');
    expect('_meta' in metadata).toBe(false);
  });

  it('does not affect other methods without the decorator', () => {
    class TestService {
      @Prompt({ name: 'only-one', description: 'desc' })
      decorated() {
        return { messages: [] };
      }

      undecorated() {
        return {};
      }
    }

    const meta = Reflect.getMetadata(MCP_PROMPT_METADATA, TestService.prototype, 'undecorated');
    expect(meta).toBeUndefined();
  });
});
