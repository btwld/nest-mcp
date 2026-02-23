import type { ZodObject } from 'zod';

export interface PromptOptions {
  name?: string;
  description: string;
  parameters?: ZodObject<any>;
}

export interface PromptMetadata {
  name: string;
  description: string;
  parameters?: ZodObject<any>;
  methodName: string;
  target: Function;
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
