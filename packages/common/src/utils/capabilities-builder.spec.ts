import { describe, expect, it } from 'vitest';
import type { McpModuleOptions } from '../interfaces/mcp-options.interface';
import { buildServerCapabilities } from './capabilities-builder';

function makeOptions(overrides: Partial<McpModuleOptions> = {}): McpModuleOptions {
  return {
    name: 'test-server',
    version: '1.0.0',
    transport: 'stdio' as McpModuleOptions['transport'],
    ...overrides,
  };
}

describe('buildServerCapabilities', () => {
  it('should include tools capability when hasTools is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: true,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tools).toEqual({ listChanged: true });
  });

  it('should not include tools capability when hasTools is false', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tools).toBeUndefined();
  });

  it('should include resources capability when hasResources is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: true,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.resources).toEqual({ subscribe: true, listChanged: true });
  });

  it('should include resources capability when hasResourceTemplates is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: true,
      hasPrompts: false,
    });
    expect(result.resources).toEqual({ subscribe: true, listChanged: true });
  });

  it('should include prompts capability when hasPrompts is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: true,
    });
    expect(result.prompts).toEqual({ listChanged: true });
  });

  it('should always include logging capability', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.logging).toEqual({});
  });

  it('should respect capability overrides from options', () => {
    const options = makeOptions({
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true, listChanged: false },
        prompts: { listChanged: false },
      },
    });
    const result = buildServerCapabilities(options, {
      hasTools: true,
      hasResources: true,
      hasResourceTemplates: false,
      hasPrompts: true,
    });
    expect(result.tools).toEqual({ listChanged: false });
    expect(result.resources).toEqual({ subscribe: true, listChanged: false });
    expect(result.prompts).toEqual({ listChanged: false });
  });

  it('should return all capabilities when everything is enabled', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: true,
      hasResources: true,
      hasResourceTemplates: true,
      hasPrompts: true,
    });
    expect(result.tools).toBeDefined();
    expect(result.resources).toBeDefined();
    expect(result.prompts).toBeDefined();
    expect(result.logging).toBeDefined();
  });

  it('should include completions capability when hasPrompts is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: true,
    });
    expect(result.completions).toEqual({});
  });

  it('should include completions capability when hasResourceTemplates is true', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: true,
      hasPrompts: false,
    });
    expect(result.completions).toEqual({});
  });

  it('should not include completions capability when only tools or resources exist', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: true,
      hasResources: true,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.completions).toBeUndefined();
  });

  it('should include tasks capability when tasks.enabled is true', () => {
    const options = makeOptions({
      capabilities: { tasks: { enabled: true } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tasks).toEqual({
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
  });

  it('should not include tasks capability when tasks is not configured', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tasks).toBeUndefined();
  });

  it('should not include tasks capability when tasks.enabled is false', () => {
    const options = makeOptions({
      capabilities: { tasks: { enabled: false } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tasks).toBeUndefined();
  });

  it('should include experimental flags when provided in options', () => {
    const options = makeOptions({
      capabilities: { experimental: { myFeature: { enabled: true }, version: 2 } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.experimental).toEqual({ myFeature: { enabled: true }, version: 2 });
  });

  it('should not include experimental when not provided', () => {
    const result = buildServerCapabilities(makeOptions(), {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.experimental).toBeUndefined();
  });

  it('should enable tools when options declares tools capability (even if registry is empty)', () => {
    const options = makeOptions({
      capabilities: { tools: { listChanged: true } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.tools).toBeDefined();
  });

  it('should enable resources when options declares resources capability (even if registry is empty)', () => {
    const options = makeOptions({
      capabilities: { resources: { subscribe: true, listChanged: true } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.resources).toBeDefined();
  });

  it('should enable completions when options declares resources capability', () => {
    const options = makeOptions({
      capabilities: { resources: { subscribe: true, listChanged: true } },
    });
    const result = buildServerCapabilities(options, {
      hasTools: false,
      hasResources: false,
      hasResourceTemplates: false,
      hasPrompts: false,
    });
    expect(result.completions).toEqual({});
  });
});
