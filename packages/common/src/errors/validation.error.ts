import { JSON_RPC_INVALID_PARAMS } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class ValidationError extends McpError {
  readonly validationErrors: ValidationDetail[];

  constructor(message: string, errors: ValidationDetail[] = []) {
    super(message, JSON_RPC_INVALID_PARAMS, { errors });
    this.name = 'ValidationError';
    this.validationErrors = errors;
  }
}

export interface ValidationDetail {
  path: string;
  message: string;
  code?: string;
}
