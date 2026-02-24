// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RequestTransformService, ResponseTransformService } from '@btwld/mcp-gateway';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

@Injectable()
export class TransformService implements OnModuleInit {
  private readonly logger = new Logger(TransformService.name);

  constructor(
    private readonly requestTransform: RequestTransformService,
    private readonly responseTransform: ResponseTransformService,
  ) {}

  onModuleInit() {
    // Add request logging transform
    this.requestTransform.register((request) => {
      this.logger.log(`[Request] ${request.upstreamName}:${request.toolName}`);
      return request;
    });

    // Add response metadata transform
    this.responseTransform.register((response) => {
      this.logger.log(
        `[Response] ${response.upstreamName}:${response.toolName} (error: ${response.isError ?? false})`,
      );
      // Add gateway metadata to text content
      const enrichedContent = response.content.map((item: unknown) => {
        if (
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          (item as Record<string, unknown>).type === 'text'
        ) {
          return item;
        }
        return item;
      });
      return { ...response, content: enrichedContent };
    });
  }
}
