import { Injectable, Logger } from '@nestjs/common';

export type ResponseTransformFn = (
  response: ToolCallResponse,
) => ToolCallResponse | Promise<ToolCallResponse>;

export interface ToolCallResponse {
  toolName: string;
  upstreamName: string;
  content: unknown[];
  isError?: boolean;
}

@Injectable()
export class ResponseTransformService {
  private readonly logger = new Logger(ResponseTransformService.name);
  private readonly transforms: ResponseTransformFn[] = [];

  register(transform: ResponseTransformFn): void {
    this.transforms.push(transform);
  }

  async apply(response: ToolCallResponse): Promise<ToolCallResponse> {
    let current = response;

    for (const transform of this.transforms) {
      try {
        current = await transform(current);
      } catch (error) {
        this.logger.error(
          `Response transform failed: ${error instanceof Error ? error.message : error}`,
        );
        throw error;
      }
    }

    return current;
  }
}
