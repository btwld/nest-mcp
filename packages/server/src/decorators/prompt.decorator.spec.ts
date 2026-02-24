import 'reflect-metadata';
import { MCP_PROMPT_METADATA } from '@btwld/mcp-common';
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
});
