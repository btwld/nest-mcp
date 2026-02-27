export interface StringSchema {
  type: 'string';
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: string;
}

export interface NumberSchema {
  type: 'number' | 'integer';
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
}

export interface BooleanSchema {
  type: 'boolean';
  title?: string;
  description?: string;
}

export interface EnumSchema {
  type: 'string';
  title?: string;
  description?: string;
  enum: string[];
  enumNames?: string[];
}

export type PrimitiveSchemaDefinition = StringSchema | NumberSchema | BooleanSchema | EnumSchema;

export interface ElicitFormRequest {
  mode?: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, PrimitiveSchemaDefinition>;
    required?: string[];
  };
  task?: unknown;
}

export interface ElicitURLRequest {
  mode: 'url';
  message: string;
  elicitationId: string;
  url: string;
  task?: unknown;
}

export type ElicitRequest = ElicitFormRequest | ElicitURLRequest;

export interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
