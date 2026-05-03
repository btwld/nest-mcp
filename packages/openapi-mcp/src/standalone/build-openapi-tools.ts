import { type JsonSchemaProperty, compactSchema, deduplicateNames } from '@nest-mcp/common';
import { applyAuth } from '../executor/auth';
import { buildRequest } from '../executor/build-request';
import { type ExecuteOptions, execute } from '../executor/execute';
import type {
  AuthConfig,
  NormalizedRequest,
  SourceConfig,
} from '../interfaces/openapi-mcp-options.interface';
import type { BuiltTool, ExecuteFn, ToolDescriptor } from '../interfaces/tool-descriptor.interface';
import { loadOpenApiDocument } from '../parser/document-loader';
import { collectDescriptors } from '../transformer/collect-descriptors';

export interface BuildOpenApiToolsResult {
  tools: BuiltTool[];
  /**
   * Register every tool on a `McpServer` from `@modelcontextprotocol/sdk`. The
   * SDK version is not pinned here; the caller passes their own server.
   */
  registerOn: (server: ServerLike) => void;
}

/**
 * Minimal shape of the SDK `McpServer` we need. Avoids a hard dep on the SDK
 * for users who only want the descriptors.
 */
export interface ServerLike {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: unknown },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
}

export interface BuildOpenApiToolsOptions extends SourceConfig, ExecuteOptions {}

export async function buildOpenApiTools(
  options: BuildOpenApiToolsOptions,
): Promise<BuildOpenApiToolsResult> {
  const document = await loadOpenApiDocument(options);
  const descriptors = collectDescriptors(document, options, console);
  deduplicateNames(descriptors);

  const tools = descriptors.map((descriptor) =>
    toBuiltTool(descriptor, options.baseUrl, options.auth, options),
  );

  return {
    tools,
    registerOn(server: ServerLike) {
      for (const tool of tools) {
        const inputSchema = options.compactList
          ? compactInputSchema(tool.descriptor.jsonSchema)
          : tool.descriptor.jsonSchema;
        server.registerTool(
          tool.descriptor.name,
          { description: tool.descriptor.description, inputSchema },
          async (args) => {
            const result = await tool.execute(args ?? {});
            return {
              content: [
                {
                  type: 'text',
                  text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
                },
              ],
            };
          },
        );
      }
    },
  };
}

function toBuiltTool(
  descriptor: ToolDescriptor,
  baseUrl: string,
  auth: AuthConfig | undefined,
  options: ExecuteOptions,
): BuiltTool {
  const buildReq = (args: Record<string, unknown>): NormalizedRequest =>
    buildRequest(baseUrl, descriptor, args);

  const executeFn: ExecuteFn = async (args, ctx) => {
    let request = buildRequest(baseUrl, descriptor, args, ctx?.inboundHeaders ?? {});
    request = await applyAuth(request, auth);
    return execute(request, descriptor.name, options);
  };

  return {
    descriptor,
    execute: executeFn,
    buildRequest: buildReq,
  };
}

function compactInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema.properties) return schema;
  return {
    ...schema,
    properties: compactSchema(schema.properties as Record<string, JsonSchemaProperty>),
  };
}
