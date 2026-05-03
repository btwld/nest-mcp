import { type JsonSchemaProperty, jsonSchemaToZod } from '@nest-mcp/common';
import type { OpenAPIV3 } from 'openapi-types';
import type {
  OpenAPIDocument,
  OperationContext,
  SourceConfig,
} from '../interfaces/openapi-mcp-options.interface';
import type {
  BodyDescriptor,
  ParameterDescriptor,
  ToolDescriptor,
} from '../interfaces/tool-descriptor.interface';
import { type ResolveLogger, resolveSchemaDeep } from '../parser/ref-resolver';
import { deriveToolName } from './derive-tool-name';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type AnyRecord = Record<string, unknown>;

/**
 * Walk every path × method, resolve refs, split params, build a Zod schema, and
 * emit a `ToolDescriptor` per supported operation. Operations using only
 * multipart bodies are skipped with a warning.
 */
export function collectDescriptors(
  doc: OpenAPIDocument,
  source: SourceConfig,
  logger: ResolveLogger = { warn: () => {} },
): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    if (!path.startsWith('/')) continue;

    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, OpenAPIV3.OperationObject>)[method];
      if (!operation) continue;

      const tags = operation.tags ?? ['default'];

      const ctx: OperationContext = {
        operationId: operation.operationId,
        method,
        path,
        tags,
        summary: operation.summary,
        description: operation.description,
        sourceName: source.name,
      };

      const includeTags = source.includeTags;
      const excludeTags = source.excludeTags;
      if (includeTags && !tags.some((t) => includeTags.includes(t))) continue;
      if (excludeTags && tags.some((t) => excludeTags.includes(t))) continue;
      if (source.tagFilter && !source.tagFilter(ctx)) continue;

      const operationParams = [
        ...(((pathItem as Record<string, unknown>).parameters as unknown[] | undefined) ?? []),
        ...((operation.parameters as unknown[] | undefined) ?? []),
      ] as AnyRecord[];

      const parameters: ParameterDescriptor[] = [];
      for (const raw of operationParams) {
        const resolved = resolveSchemaDeep(doc, raw, logger);
        if (!resolved) continue;
        const location = resolved.in as ParameterDescriptor['in'] | undefined;
        if (location !== 'path' && location !== 'query') continue; // skip header/cookie
        const paramName = resolved.name as string | undefined;
        if (!paramName) continue;
        const schema = (resolveSchemaDeep(doc, resolved.schema, logger) as
          | Record<string, unknown>
          | undefined) ?? { type: 'string' };
        parameters.push({
          name: paramName,
          in: location,
          required: Boolean(resolved.required) || location === 'path',
          description: resolved.description as string | undefined,
          schema,
        });
      }

      const body = extractBody(doc, operation, logger);
      if (operation.requestBody && body === 'unsupported') {
        logger.warn(
          `[openapi-mcp] ${method.toUpperCase()} ${path}: only multipart bodies supported; skipping.`,
        );
        continue;
      }

      const inputShape = buildInputShape(parameters, body, logger);
      const baseName = source.nameFormatter ? source.nameFormatter(ctx) : deriveToolName(ctx);
      const namespacedName = source.name ? `${source.name}.${baseName}` : baseName;

      const description =
        source.descriptionFormatter?.(ctx) ??
        operation.summary ??
        operation.description ??
        `${method.toUpperCase()} ${path}`;

      descriptors.push({
        name: namespacedName,
        description,
        zodSchema: jsonSchemaToZod(inputShape as JsonSchemaProperty),
        jsonSchema: inputShape,
        context: ctx,
        parameters,
        body: body === 'unsupported' || body === undefined ? undefined : body,
        request: { method: method.toUpperCase(), pathTemplate: path },
      });
    }
  }

  return descriptors;
}

function extractBody(
  doc: OpenAPIDocument,
  operation: OpenAPIV3.OperationObject,
  logger: ResolveLogger,
): BodyDescriptor | undefined | 'unsupported' {
  const requestBody = operation.requestBody as AnyRecord | undefined;
  if (!requestBody) return undefined;
  const resolved = resolveSchemaDeep(doc, requestBody, logger);
  if (!resolved) return undefined;
  const content = resolved.content as AnyRecord | undefined;
  if (!content) return undefined;
  const json = content['application/json'] as AnyRecord | undefined;
  if (!json) {
    if (Object.keys(content).some((mime) => mime.startsWith('multipart/'))) {
      return 'unsupported';
    }
    return undefined;
  }
  const schema = (resolveSchemaDeep(doc, json.schema, logger) as
    | Record<string, unknown>
    | undefined) ?? {
    type: 'object',
    additionalProperties: true,
  };
  const required = Boolean(resolved.required);
  if (schema.type === 'array') {
    return { wrapped: true, arrayBody: true, required, schema };
  }
  if (schema.type === 'object' && schema.properties) {
    return { wrapped: false, arrayBody: false, required, schema };
  }
  return { wrapped: true, arrayBody: false, required, schema };
}

function buildInputShape(
  parameters: ParameterDescriptor[],
  body: BodyDescriptor | undefined | 'unsupported',
  logger: ResolveLogger,
): Record<string, unknown> {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const p of parameters) {
    if (properties[p.name]) {
      logger.warn(`[openapi-mcp] parameter name collision on "${p.name}"; first occurrence wins.`);
      continue;
    }
    properties[p.name] = p.schema as JsonSchemaProperty;
    if (p.required) required.push(p.name);
  }

  if (body && body !== 'unsupported') {
    if (body.arrayBody) {
      if (properties.items) {
        logger.warn('[openapi-mcp] array-body collides with `items` parameter; body skipped.');
      } else {
        properties.items = body.schema as JsonSchemaProperty;
        if (body.required) required.push('items');
      }
    } else if (body.wrapped) {
      if (properties.body) {
        logger.warn('[openapi-mcp] body wrapper collides with `body` parameter; body skipped.');
      } else {
        properties.body = body.schema as JsonSchemaProperty;
        if (body.required) required.push('body');
      }
    } else if (body.schema.properties) {
      const bodyProps = body.schema.properties as Record<string, JsonSchemaProperty>;
      const bodyRequired = (body.schema.required as string[] | undefined) ?? [];
      for (const [key, propSchema] of Object.entries(bodyProps)) {
        if (properties[key]) {
          logger.warn(
            `[openapi-mcp] body property "${key}" collides with parameter; body property skipped.`,
          );
          continue;
        }
        properties[key] = propSchema;
        if (bodyRequired.includes(key)) required.push(key);
      }
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
