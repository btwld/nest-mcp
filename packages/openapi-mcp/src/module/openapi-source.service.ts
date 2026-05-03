import { type JsonSchemaProperty, compactSchema } from '@nest-mcp/common';
import { deduplicateNames } from '@nest-mcp/common';
import { McpRegistryService, type RegisteredTool } from '@nest-mcp/server';
import { Logger } from '@nestjs/common';
import { applyAuth } from '../executor/auth';
import { buildRequest } from '../executor/build-request';
import { execute } from '../executor/execute';
import type { SourceConfig } from '../interfaces/openapi-mcp-options.interface';
import type { ToolDescriptor } from '../interfaces/tool-descriptor.interface';
import { loadOpenApiDocument } from '../parser/document-loader';
import { collectDescriptors } from '../transformer/collect-descriptors';

/**
 * Owns the registration lifecycle for a single OpenAPI source. v1: load doc
 * once at boot, transform to descriptors, register via `replaceExternalBatch`.
 * No runtime hot reload.
 */
export class OpenApiSourceService {
  private readonly logger: Logger;
  private readonly source: string;

  constructor(
    readonly config: SourceConfig,
    private readonly registry: McpRegistryService,
  ) {
    this.source = `openapi:${config.name ?? 'default'}`;
    this.logger = new Logger(`OpenApiSourceService[${this.source}]`);
  }

  async registerAll(): Promise<{ added: string[]; removed: string[]; unchanged: number }> {
    const document = await loadOpenApiDocument(this.config);
    const descriptors = collectDescriptors(document, this.config, this.logger);
    deduplicateNames(descriptors);

    const tools = descriptors.map((d) => this.toRegisteredTool(d));
    const result = this.registry.replaceExternalBatch(this.source, tools);
    this.logger.log(
      `Registered ${result.added.length} tools from ${this.config.documentUrl ?? 'in-memory document'}`,
    );
    return result;
  }

  private toRegisteredTool(descriptor: ToolDescriptor): RegisteredTool {
    const inputSchema = this.config.compactList
      ? compactInputSchema(descriptor.jsonSchema)
      : descriptor.jsonSchema;

    const tool: RegisteredTool = {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.zodSchema,
      inputSchema,
      methodName: 'invoke',
      target: Object as unknown as RegisteredTool['target'],
      instance: {
        invoke: async (args: Record<string, unknown>) => {
          let request = buildRequest(this.config.baseUrl, descriptor, args ?? {});
          request = await applyAuth(request, this.config.auth);
          const result = await execute(request, descriptor.name, {
            timeoutMs: this.config.timeoutMs,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
              },
            ],
          };
        },
      },
    };

    return tool;
  }
}

function compactInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema.properties) return schema;
  // `compactSchema` recurses into nested object properties on its own, so
  // applying it once at the top reaches the full tree.
  return {
    ...schema,
    properties: compactSchema(schema.properties as Record<string, JsonSchemaProperty>),
  };
}
