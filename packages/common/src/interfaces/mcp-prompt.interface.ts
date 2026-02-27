import type { ZodObject, ZodRawShape } from 'zod';
import type { Icon } from './mcp-tool.interface';

export interface PromptOptions {
  name?: string;
  /** Human-readable display title for the prompt (distinct from the machine name). */
  title?: string;
  description: string;
  parameters?: ZodObject<ZodRawShape>;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

export interface PromptMetadata {
  name: string;
  /** Human-readable display title for the prompt (distinct from the machine name). */
  title?: string;
  description: string;
  parameters?: ZodObject<ZodRawShape>;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  methodName: string;
  target: abstract new (...args: unknown[]) => unknown;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: PromptMessageContent;
}

export type PromptMessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}
