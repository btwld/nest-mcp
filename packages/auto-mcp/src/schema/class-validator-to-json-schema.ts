import type { JsonSchemaProperty } from '@nest-mcp/common';

/**
 * Lazy-load class-validator. The package is an *optional* peer dep — if a
 * consumer doesn't use class-validator, schema synthesis falls back to plain
 * `design:paramtypes` instead of throwing.
 */
function loadMetadataStorage(): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('class-validator');
    return typeof mod.getMetadataStorage === 'function' ? mod.getMetadataStorage() : null;
  } catch {
    return null;
  }
}

interface ClassValidatorMetadata {
  target: unknown;
  propertyName: string;
  type: string;
  constraints?: unknown[];
  groups?: string[];
}

interface ClassValidatorTypeMetadata {
  target: unknown;
  propertyName: string;
  reflectedType?: unknown;
}

interface MetadataStorage {
  getTargetValidationMetadatas(
    target: unknown,
    targetSchema: string | undefined,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): ClassValidatorMetadata[];
  // class-transformer fallback storage may live here
  getTypeMetadatas?(): Map<unknown, Map<string, ClassValidatorTypeMetadata>>;
}

/**
 * Synthesize a JSON Schema for a DTO class from class-validator metadata.
 * Returns `undefined` when the class has no validation metadata (caller should
 * fall back to `design:paramtypes`).
 */
export function classValidatorToJsonSchema(
  cls: unknown,
  visited: Set<unknown> = new Set(),
): JsonSchemaProperty | undefined {
  if (!cls || typeof cls !== 'function') return undefined;
  if (visited.has(cls)) return { type: 'object', additionalProperties: true };

  const storage = loadMetadataStorage() as MetadataStorage | null;
  if (!storage) return undefined;

  const metadata = storage.getTargetValidationMetadatas(cls, undefined, true, false);
  if (!metadata || metadata.length === 0) {
    // Walk inheritance chain — class-validator does this internally too
    const parent = Object.getPrototypeOf(cls.prototype)?.constructor;
    if (parent && parent !== Object && parent !== cls) {
      return classValidatorToJsonSchema(parent, new Set([...visited, cls]));
    }
    return undefined;
  }

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  const seenOptional = new Set<string>();

  for (const m of metadata) {
    const prop = m.propertyName;
    const existing: JsonSchemaProperty = properties[prop] ?? {};
    if (m.type === 'conditionalValidation') continue;
    if (m.type === 'isOptional' || m.type === 'conditional') {
      seenOptional.add(prop);
      continue;
    }
    applyConstraint(existing, m);
    properties[prop] = existing;
  }

  for (const prop of Object.keys(properties)) {
    if (!seenOptional.has(prop)) required.push(prop);
    if (!properties[prop].type) properties[prop].type = 'string';
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function applyConstraint(target: JsonSchemaProperty, m: ClassValidatorMetadata): void {
  switch (m.type) {
    case 'isString':
      target.type = 'string';
      break;
    case 'isInt':
      target.type = 'integer';
      break;
    case 'isNumber':
      target.type = 'number';
      break;
    case 'isBoolean':
      target.type = 'boolean';
      break;
    case 'isDate':
      target.type = 'string';
      target.format = 'date-time';
      break;
    case 'isUUID':
      target.type = 'string';
      target.format = 'uuid';
      break;
    case 'isEmail':
      target.type = 'string';
      target.format = 'email';
      break;
    case 'isUrl':
      target.type = 'string';
      target.format = 'url';
      break;
    case 'isArray':
      target.type = 'array';
      if (!target.items) target.items = { type: 'string' };
      break;
    case 'isEnum': {
      const values = m.constraints?.[0];
      if (typeof values === 'object' && values !== null) {
        target.enum = Array.from(
          new Set(Object.values(values as Record<string, unknown>)),
        ) as unknown[];
        if (target.enum?.every((v) => typeof v === 'string')) target.type = 'string';
      }
      break;
    }
    case 'minLength':
    case 'maxLength':
    case 'min':
    case 'max':
    case 'matches':
      // Constraint-level details are skipped in v1 — we keep the shape correct.
      // Future: map to JSON Schema `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`.
      break;
    case 'arrayMinSize':
    case 'arrayMaxSize':
      target.type = 'array';
      break;
  }
}
