// @nest-mcp/auto-mcp - Auto-expose NestJS controllers as MCP tools

export * from './auto-mcp.module';
export * from './interfaces/auto-mcp-options.interface';
export * from './decorators';
export { RouteScannerService } from './discovery/route-scanner.service';
export type { RouteDescriptor, HttpVerb } from './discovery/route-descriptor';
export type { ResolvedParam, ParamKind } from './discovery/param-introspector';
export { introspectParams, ROUTE_ARGS_METADATA } from './discovery/param-introspector';
export { PipelineExecutorService } from './execution/pipeline-executor.service';
export { RouteRegistrarService } from './registration/route-registrar.service';
export { buildInputSchema } from './schema/schema-synthesizer';
export { classValidatorToJsonSchema } from './schema/class-validator-to-json-schema';
