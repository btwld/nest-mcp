import type { Icon } from './mcp-tool.interface';

export interface ResourceOptions {
  uri: string;
  name?: string;
  /** Human-readable display title for the resource (distinct from the machine name). */
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

export interface ResourceMetadata {
  uri: string;
  name: string;
  /** Human-readable display title for the resource (distinct from the machine name). */
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  methodName: string;
  target: abstract new (...args: never[]) => unknown;
}

export interface ResourceTemplateOptions {
  uriTemplate: string;
  name?: string;
  /** Human-readable display title for the resource template (distinct from the machine name). */
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

export interface ResourceTemplateMetadata {
  uriTemplate: string;
  name: string;
  /** Human-readable display title for the resource template (distinct from the machine name). */
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  methodName: string;
  target: abstract new (...args: never[]) => unknown;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
}
