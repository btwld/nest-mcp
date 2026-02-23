import { Injectable, Logger } from '@nestjs/common';

export interface RequestTransformFn {
  (request: ToolCallRequest): ToolCallRequest | Promise<ToolCallRequest>;
}

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

  async apply(request: ToolCallRequest): Promise<ToolCallRequest> {
    let current = request;

    for (const transform of this.transforms) {
      try {
        current = await transform(current);
      } catch (error) {
        this.logger.error(
          `Request transform failed: ${error instanceof Error ? error.message : error}`,
        );
        throw error;
      }
    }

    return current;
  }
}
