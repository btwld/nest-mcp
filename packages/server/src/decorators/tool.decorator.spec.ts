import 'reflect-metadata';
import { MCP_TOOL_METADATA } from '@btwld/mcp-common';
import { z } from 'zod';
import { Tool } from './tool.decorator';

describe('Tool decorator', () => {
  it('stores ToolMetadata on decorated method', () => {
    class TestService {
      @Tool({ description: 'A test tool' })
      myTool() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'myTool');

    expect(metadata).toBeDefined();
    expect(metadata.name).toBe('myTool');
    expect(metadata.description).toBe('A test tool');
    expect(metadata.methodName).toBe('myTool');
    expect(metadata.target).toBe(TestService);
  });

  it('uses propertyKey as name when options.name is omitted', () => {
    class TestService {
      @Tool({ description: 'desc' })
      autoNamed() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'autoNamed');

    expect(metadata.name).toBe('autoNamed');
  });

  it('uses explicit name when provided', () => {
    class TestService {
      @Tool({ name: 'custom-name', description: 'desc' })
      methodName() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'methodName');

    expect(metadata.name).toBe('custom-name');
    expect(metadata.methodName).toBe('methodName');
  });

  it('stores Zod parameters, outputSchema, and annotations', () => {
    const params = z.object({ query: z.string() });
    const output = z.object({ result: z.string() });
    const annotations = {
      title: 'My Tool',
      readOnlyHint: true,
      destructiveHint: false,
    };

    class TestService {
      @Tool({
        description: 'tool with schemas',
        parameters: params,
        outputSchema: output,
        annotations,
      })
      schemaMethod() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'schemaMethod');

    expect(metadata.parameters).toBe(params);
    expect(metadata.outputSchema).toBe(output);
    expect(metadata.annotations).toEqual(annotations);
  });

  it('stores independent metadata per method on same class', () => {
    class TestService {
      @Tool({ description: 'first' })
      toolA() {
        return 'a';
      }

      @Tool({ name: 'tool-b', description: 'second' })
      toolB() {
        return 'b';
      }
    }

    const metaA = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'toolA');
    const metaB = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'toolB');

    expect(metaA.name).toBe('toolA');
    expect(metaA.description).toBe('first');
    expect(metaB.name).toBe('tool-b');
    expect(metaB.description).toBe('second');
  });

  it('stores title when provided', () => {
    class TestService {
      @Tool({ description: 'desc', title: 'My Tool' })
      titled() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'titled');
    expect(metadata.title).toBe('My Tool');
  });

  it('does not include title key when title is not provided', () => {
    class TestService {
      @Tool({ description: 'desc' })
      noTitle() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'noTitle');
    expect('title' in metadata).toBe(false);
  });

  it('stores icons when provided', () => {
    const icons = [{ uri: 'https://example.com/tool-icon.png' }];

    class TestService {
      @Tool({ description: 'with icons', icons })
      withIcons() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'withIcons');
    expect(metadata.icons).toBe(icons);
  });

  it('stores execution config when provided', () => {
    const execution = { timeout: 5000 };

    class TestService {
      @Tool({ description: 'with execution', execution })
      withExecution() {
        return 'ok';
      }
    }

    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'withExecution');
    expect(metadata.execution).toBe(execution);
  });

  it('does not affect other methods without the decorator', () => {
    class TestService {
      @Tool({ description: 'decorated' })
      decorated() {
        return 'ok';
      }

      undecorated() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(MCP_TOOL_METADATA, TestService.prototype, 'undecorated');
    expect(meta).toBeUndefined();
  });
});
