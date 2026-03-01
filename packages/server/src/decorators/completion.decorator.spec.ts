import 'reflect-metadata';
import { MCP_COMPLETION_METADATA } from '@nest-mcp/common';
import { describe, expect, it } from 'vitest';
import { Completion } from './completion.decorator';
import type { CompletionMetadata } from './completion.decorator';

describe('Completion decorator', () => {
  it('stores completion metadata for ref/prompt', () => {
    class TestProvider {
      @Completion({ refType: 'ref/prompt', refName: 'code_review' })
      completeCodeReview() {
        return { values: [] };
      }
    }

    const metadata: CompletionMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'completeCodeReview',
    );

    expect(metadata).toBeDefined();
    expect(metadata.refType).toBe('ref/prompt');
    expect(metadata.refName).toBe('code_review');
    expect(metadata.methodName).toBe('completeCodeReview');
    expect(metadata.target).toBe(TestProvider);
  });

  it('stores completion metadata for ref/resource', () => {
    class TestProvider {
      @Completion({ refType: 'ref/resource', refName: 'file:///{path}' })
      completeFilePath() {
        return { values: [] };
      }
    }

    const metadata: CompletionMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'completeFilePath',
    );

    expect(metadata).toBeDefined();
    expect(metadata.refType).toBe('ref/resource');
    expect(metadata.refName).toBe('file:///{path}');
    expect(metadata.methodName).toBe('completeFilePath');
  });

  it('does not affect other methods on the same class', () => {
    class TestProvider {
      @Completion({ refType: 'ref/prompt', refName: 'test' })
      complete() {
        return { values: [] };
      }

      other() {}
    }

    const otherMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'other',
    );

    expect(otherMetadata).toBeUndefined();
  });

  it('stores independent metadata per method on same class', () => {
    class TestProvider {
      @Completion({ refType: 'ref/prompt', refName: 'prompt-a' })
      completeA() {
        return { values: [] };
      }

      @Completion({ refType: 'ref/resource', refName: 'file:///{path}' })
      completeB() {
        return { values: [] };
      }
    }

    const metaA: CompletionMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'completeA',
    );
    const metaB: CompletionMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'completeB',
    );

    expect(metaA.refType).toBe('ref/prompt');
    expect(metaA.refName).toBe('prompt-a');
    expect(metaB.refType).toBe('ref/resource');
    expect(metaB.refName).toBe('file:///{path}');
  });

  it('target points to the class constructor', () => {
    class TestProvider {
      @Completion({ refType: 'ref/prompt', refName: 'greet' })
      greet() {
        return { values: [] };
      }
    }

    const metadata: CompletionMetadata = Reflect.getMetadata(
      MCP_COMPLETION_METADATA,
      TestProvider.prototype,
      'greet',
    );

    expect(metadata.target).toBe(TestProvider);
  });
});
