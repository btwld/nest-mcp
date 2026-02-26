import { Injectable, Logger } from '@nestjs/common';
import { extractErrorMessage } from '../utils/error-utils';

export type RequestTransformFn = (
  request: ToolCallRequest,
) => ToolCallRequest | Promise<ToolCallRequest>;

export interface ToolCallRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  upstreamName: string;
}

@Injectable()
export class RequestTransformService {
  private readonly logger = new Logger(RequestTransformService.name);
  private readonly transforms: RequestTransformFn[] = [];

  register(transform: RequestTransformFn): void {
    this.transforms.push(transform);
  }

  async apply(initial: ToolCallRequest): Promise<ToolCallRequest> {
    return this.transforms.reduce<Promise<ToolCallRequest>>(
      async (acc, transform) => {
        const current = await acc;
        try {
          return await transform(current);
        } catch (error) {
          this.logger.error(`Request transform failed: ${extractErrorMessage(error)}`);
          throw error;
        }
      },
      Promise.resolve(initial),
    );
  }
}
