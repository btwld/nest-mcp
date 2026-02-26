import type { ToolContent } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
import { extractErrorMessage } from '../utils/error-utils';

export type ResponseTransformFn = (
  response: ToolCallResponse,
) => ToolCallResponse | Promise<ToolCallResponse>;

export interface ToolCallResponse {
  toolName: string;
  upstreamName: string;
  content: ToolContent[];
  isError?: boolean;
}

@Injectable()
export class ResponseTransformService {
  private readonly logger = new Logger(ResponseTransformService.name);
  private readonly transforms: ResponseTransformFn[] = [];

  register(transform: ResponseTransformFn): void {
    this.transforms.push(transform);
  }

  async apply(initial: ToolCallResponse): Promise<ToolCallResponse> {
    return this.transforms.reduce<Promise<ToolCallResponse>>(async (acc, transform) => {
      const current = await acc;
      try {
        return await transform(current);
      } catch (error) {
        this.logger.error(`Response transform failed: ${extractErrorMessage(error)}`);
        throw error;
      }
    }, Promise.resolve(initial));
  }
}
