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
    // Request transform: inject default units for weather tools
    this.requestTransform.register((request) => {
      this.logger.log(`[Request] ${request.upstreamName}:${request.toolName}`);

      // Inject default celsius units for weather tool if not specified
      if (request.toolName === 'get_weather' && request.upstreamName === 'playground') {
        if (!request.arguments.units) {
          return {
            ...request,
            arguments: { ...request.arguments, units: 'celsius' },
          };
        }
      }

      return request;
    });

    // Response transform: enrich responses with gateway metadata
    this.responseTransform.register((response) => {
      this.logger.log(
        `[Response] ${response.upstreamName}:${response.toolName} (error: ${response.isError ?? false})`,
      );

      // Enrich JSON text content with _gateway metadata
      const enrichedContent = response.content.map((item: unknown) => {
        if (
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          (item as Record<string, unknown>).type === 'text'
        ) {
          const textItem = item as { type: string; text: string };
          try {
            const parsed = JSON.parse(textItem.text);
            const enriched = {
              ...parsed,
              _gateway: {
                upstream: response.upstreamName,
                tool: response.toolName,
                timestamp: new Date().toISOString(),
                cached: false,
              },
            };
            return { ...textItem, text: JSON.stringify(enriched) };
          } catch {
            // Not JSON, return as-is
            return item;
          }
        }
        return item;
      });

      return { ...response, content: enrichedContent };
    });
  }
}
