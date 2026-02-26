import { JSON_RPC_INTERNAL_ERROR } from '../constants/error-codes';

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly isRetriable: boolean;

  constructor(
    message: string,
    code: number = JSON_RPC_INTERNAL_ERROR,
    data?: unknown,
    isRetriable = false,
  ) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
    this.isRetriable = isRetriable;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJsonRpcError() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined && { data: this.data }),
    };
  }
}
