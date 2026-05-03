import type { JsonSchemaProperty } from '@nest-mcp/common';
import type { McpExposeOptions } from '../decorators/metadata-keys';
import type { ResolvedParam } from '../discovery/param-introspector';
import { classValidatorToJsonSchema } from './class-validator-to-json-schema';

const PRIMITIVE_BY_CTOR = new Map<unknown, JsonSchemaProperty>([
  [String, { type: 'string' }],
  [Number, { type: 'number' }],
  [Boolean, { type: 'boolean' }],
  [Object, { type: 'object', additionalProperties: true }],
]);

/**
 * Build the input JSON schema for a controller route from its decoded params.
 *
 * Tier 1: explicit `@McpExpose({ schema })` always wins.
 * Tier 2: each DTO class is run through `class-validator` metadata.
 * Tier 3: fall back to `design:paramtypes` primitives.
 *
 * The output is always shape `{ type: 'object', properties, required, additionalProperties: false }`.
 * Body / Query / Param keys flatten into the same top-level `properties` map.
 */
export function buildInputSchema(
  params: ResolvedParam[],
  expose?: McpExposeOptions,
): { schema: JsonSchemaProperty; degraded: boolean } {
  if (expose?.schema) return { schema: expose.schema as JsonSchemaProperty, degraded: false };

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  let degraded = false;

  for (const param of params) {
    // Listing each non-mapped kind explicitly (rather than `default:`) preserves
    // narrowing for the `assertNeverKind(param.kind)` exhaustiveness check below.
    if (
      param.kind === 'request' ||
      param.kind === 'response' ||
      param.kind === 'next' ||
      param.kind === 'host' ||
      param.kind === 'session' ||
      param.kind === 'ip' ||
      param.kind === 'file'
    ) {
      continue;
    }
    if (param.kind === 'unsupported') {
      degraded = true;
      continue;
    }

    if (param.kind === 'body') {
      const fromValidator =
        param.metaType && typeof param.metaType === 'function'
          ? classValidatorToJsonSchema(param.metaType)
          : undefined;
      if (fromValidator?.properties) {
        Object.assign(properties, fromValidator.properties);
        if (fromValidator.required) required.push(...fromValidator.required);
        continue;
      }
      const primitive = PRIMITIVE_BY_CTOR.get(param.metaType);
      if (param.data) {
        properties[param.data] = primitive ?? { type: 'string' };
        required.push(param.data);
      } else {
        // Whole-body without validator metadata: open object
        properties.body = primitive ?? { type: 'object', additionalProperties: true };
        required.push('body');
        if (!primitive) degraded = true;
      }
      continue;
    }

    if (param.kind === 'query') {
      if (param.data) {
        properties[param.data] = paramSchema(param);
        // Query params are typically optional unless decorated with @IsNotEmpty etc.
      } else {
        const fromValidator =
          param.metaType && typeof param.metaType === 'function'
            ? classValidatorToJsonSchema(param.metaType)
            : undefined;
        if (fromValidator?.properties) {
          Object.assign(properties, fromValidator.properties);
          continue;
        }
        properties.query = { type: 'object', additionalProperties: true };
      }
      continue;
    }

    if (param.kind === 'param') {
      if (param.data) {
        properties[param.data] = paramSchema(param);
        required.push(param.data); // path params are required
      }
      continue;
    }

    if (param.kind === 'headers') {
      if (param.data) properties[param.data] = paramSchema(param);
      continue;
    }

    // Exhaustiveness — TS narrows `param.kind` to `never` here. If the union
    // gains a variant, this line forces us to handle it.
    assertNeverKind(param.kind);
  }

  return {
    schema: {
      type: 'object',
      properties,
      required: Array.from(new Set(required)),
      additionalProperties: false,
    },
    degraded,
  };
}

function paramSchema(param: ResolvedParam): JsonSchemaProperty {
  return PRIMITIVE_BY_CTOR.get(param.metaType) ?? { type: 'string' };
}

function assertNeverKind(_kind: never): void {
  // No-op at runtime; the exhaustiveness check is purely compile-time.
}
