import {
  type JsonSchemaProperty,
  MCP_AUTO_MCP_OPTIONS,
  deduplicateNames,
  jsonSchemaToZod,
} from '@nest-mcp/common';
import { McpRegistryService, type RegisteredTool } from '@nest-mcp/server';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { RouteDescriptor } from '../discovery/route-descriptor';
import { RouteScannerService } from '../discovery/route-scanner.service';
import { PipelineExecutorService } from '../execution/pipeline-executor.service';
import type { AutoMcpOptions } from '../interfaces/auto-mcp-options.interface';
import { applyNamespace, defaultDescription, defaultToolName } from '../naming/naming-strategy';
import { buildInputSchema } from '../schema/schema-synthesizer';

const SOURCE_PREFIX = 'nestjs';

@Injectable()
export class RouteRegistrarService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteRegistrarService.name);

  constructor(
    @Inject(MCP_AUTO_MCP_OPTIONS) private readonly options: AutoMcpOptions,
    private readonly scanner: RouteScannerService,
    private readonly executor: PipelineExecutorService,
    @Inject(McpRegistryService) private readonly registry: McpRegistryService,
  ) {}

  onApplicationBootstrap(): void {
    const routes = this.scanner.scan(this.options);
    const namespace = this.options.namespace ?? SOURCE_PREFIX;
    const tools: RegisteredTool[] = [];

    for (const route of routes) {
      const tool = this.toRegisteredTool(route, namespace);
      if (tool) tools.push(tool);
    }

    deduplicateNames(tools);
    const result = this.registry.replaceExternalBatch(`${SOURCE_PREFIX}`, tools);
    this.logger.log(
      `auto-mcp registered ${result.added.length} tool(s) from ${routes.length} route(s).`,
    );
  }

  private toRegisteredTool(
    route: RouteDescriptor,
    namespace: string | false,
  ): RegisteredTool | null {
    const { schema, degraded } = buildInputSchema(route.params, route.expose);
    if (degraded && this.options.onSchemaError === 'throw') {
      throw new Error(
        `auto-mcp: ${route.controllerName}.${route.methodName} has params we cannot synthesize a schema for.`,
      );
    }
    if (degraded && this.options.onSchemaError === 'skip') {
      this.logger.warn(
        `auto-mcp: skipping ${route.controllerName}.${route.methodName} (degraded schema).`,
      );
      return null;
    }
    if (degraded) {
      this.logger.warn(
        `auto-mcp: ${route.controllerName}.${route.methodName} has parameters with no inferable schema; using a permissive object.`,
      );
    }

    const baseName = defaultToolName(route);
    const name = applyNamespace(baseName, namespace);
    const description = defaultDescription(route);

    const zodSchema = jsonSchemaToZod(schema as JsonSchemaProperty);

    return {
      name,
      description,
      parameters: zodSchema,
      inputSchema: schema,
      methodName: route.methodName,
      target: route.controllerType,
      instance: {
        [route.methodName]: async (input: Record<string, unknown>) => {
          const result = await this.executor.invoke(route, input ?? {}, this.options, name);
          return {
            content: [
              {
                type: 'text' as const,
                text: typeof result === 'string' ? result : JSON.stringify(result),
              },
            ],
          };
        },
      },
    };
  }
}
