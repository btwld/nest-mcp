import { JSON_RPC_INTERNAL_ERROR } from '../constants/error-codes';

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number = JSON_RPC_INTERNAL_ERROR, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
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
