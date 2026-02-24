export interface ResourceOptions {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceMetadata {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  methodName: string;
  target: abstract new (...args: unknown[]) => unknown;
}

export interface ResourceTemplateOptions {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateMetadata {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  methodName: string;
  target: abstract new (...args: unknown[]) => unknown;
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
