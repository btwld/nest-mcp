export const RAW_ARGUMENTS_ERROR_PATH = "$raw";
export const ROOT_ARGUMENTS_ERROR_PATH = "$root";
export const MAX_ARGUMENT_JSON_BYTES = 64 * 1_024;

const MAX_SCHEMA_DEPTH = 16;

type JsonObject = Record<string, unknown>;

interface ArgumentNodeBase {
  readonly path: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly required: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
}

export interface ArgumentObjectNode extends ArgumentNodeBase {
  readonly kind: "object";
  readonly properties: readonly ArgumentProperty[];
  readonly allowAdditionalProperties: boolean;
}

export interface ArgumentStringNode extends ArgumentNodeBase {
  readonly kind: "string";
  readonly enumValues?: readonly string[] | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly format?: string | undefined;
}

export interface ArgumentNumberNode extends ArgumentNodeBase {
  readonly kind: "number" | "integer";
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
}

export interface ArgumentBooleanNode extends ArgumentNodeBase {
  readonly kind: "boolean";
}

export interface ArgumentArrayNode extends ArgumentNodeBase {
  readonly kind: "array";
  readonly items: ArgumentSchemaNode;
  readonly minItems?: number | undefined;
  readonly maxItems?: number | undefined;
}

export type ArgumentJsonExpectedType =
  "object" | "string" | "number" | "integer" | "boolean" | "array";

export interface ArgumentJsonNode extends ArgumentNodeBase {
  readonly kind: "json";
  readonly expectedType?: ArgumentJsonExpectedType;
  readonly fallbackReason: string;
}

export type ArgumentSchemaNode =
  | ArgumentObjectNode
  | ArgumentStringNode
  | ArgumentNumberNode
  | ArgumentBooleanNode
  | ArgumentArrayNode
  | ArgumentJsonNode;

export interface ArgumentProperty {
  readonly name: string;
  readonly node: ArgumentSchemaNode;
}

export type ArgumentSchemaAnalysis =
  | {
      readonly supported: true;
      readonly root: ArgumentObjectNode;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export type ArgumentFieldErrors = Readonly<Record<string, string>>;

export type ArgumentParseResult =
  | {
      readonly success: true;
      readonly data: Record<string, unknown>;
      readonly mode: "fields" | "raw";
    }
  | {
      readonly success: false;
      readonly errors: ArgumentFieldErrors;
      readonly mode: "fields" | "raw";
    };

export interface ArgumentFormNames {
  readonly prefix?: string;
}

const UNSUPPORTED_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "if",
  "maxContains",
  "maxProperties",
  "minContains",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/u;

class UnsupportedSchemaError extends Error {}

export function analyzeArgumentSchema(schema: unknown): ArgumentSchemaAnalysis {
  try {
    const stack = new WeakSet<object>();
    const root = buildNode(schema, [], true, 0, stack);
    if (root.kind !== "object") {
      return {
        supported: false,
        reason: "A tool input schema must have an object at its root.",
      };
    }
    return { supported: true, root };
  } catch (error) {
    return {
      supported: false,
      reason:
        error instanceof UnsupportedSchemaError
          ? error.message
          : "The input schema could not be interpreted safely.",
    };
  }
}

export function createDefaultArguments(schema: unknown): Record<string, unknown> {
  const analysis = analyzeArgumentSchema(schema);
  if (!analysis.supported) return {};
  return defaultObjectValue(analysis.root);
}

export function parseJsonSchemaArguments(
  schema: unknown,
  formData: FormData,
  options: ArgumentFormNames = {},
): ArgumentParseResult {
  const prefix = options.prefix ?? "tool-arguments";
  const analysis = analyzeArgumentSchema(schema);
  const requestedMode = readFormString(formData, argumentModeName(prefix));
  const mode = !analysis.supported || requestedMode === "raw" ? "raw" : "fields";

  if (mode === "raw") {
    return parseRawArguments(analysis, formData, prefix);
  }
  if (!analysis.supported) {
    return {
      success: false,
      errors: { [ROOT_ARGUMENTS_ERROR_PATH]: analysis.reason },
      mode,
    };
  }

  const errors = new Map<string, string>();
  const entries = parseObjectFields(analysis.root, formData, prefix, errors);
  if (errors.size > 0) {
    return { success: false, errors: Object.fromEntries(errors), mode };
  }
  const data = Object.fromEntries(entries);
  if (jsonByteLength(data) > MAX_ARGUMENT_JSON_BYTES) {
    return {
      success: false,
      errors: {
        [ROOT_ARGUMENTS_ERROR_PATH]: `Arguments must be no larger than ${String(MAX_ARGUMENT_JSON_BYTES / 1_024)} KiB.`,
      },
      mode,
    };
  }
  return { success: true, data, mode };
}

export function argumentModeName(prefix = "tool-arguments"): string {
  return `${prefix}.mode`;
}

export function argumentRawName(prefix = "tool-arguments"): string {
  return `${prefix}.raw`;
}

export function argumentValueName(path: string, prefix = "tool-arguments"): string {
  return `${prefix}.fields.${encodeURIComponent(path)}.value`;
}

export function argumentIncludedName(path: string, prefix = "tool-arguments"): string {
  return `${prefix}.fields.${encodeURIComponent(path)}.included`;
}

export function argumentPath(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  return `/${parts.map(escapeJsonPointerToken).join("/")}`;
}

function buildNode(
  schemaValue: unknown,
  pathParts: readonly string[],
  required: boolean,
  depth: number,
  stack: WeakSet<object>,
): ArgumentSchemaNode {
  const path = argumentPath(pathParts);
  const schema = asObject(schemaValue);
  if (!schema) throw unsupported(path, "must be a JSON Schema object");
  if (depth > MAX_SCHEMA_DEPTH) {
    throw unsupported(path, `exceeds the supported nesting depth of ${String(MAX_SCHEMA_DEPTH)}`);
  }
  if (stack.has(schema)) throw unsupported(path, "contains a circular schema reference");

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      throw unsupported(
        path,
        `uses JSON Schema keyword '${keyword}', which cannot be mapped faithfully to fields`,
      );
    }
  }

  const type = schema.type;
  if (typeof type !== "string") {
    throw unsupported(path, "must declare one unambiguous type");
  }

  stack.add(schema);
  try {
    const base = readBaseNode(schema, path, required);
    switch (type) {
      case "object":
        return buildObjectNode(schema, base, pathParts, depth, stack);
      case "string":
        return buildStringNode(schema, base);
      case "number":
      case "integer":
        return buildNumberNode(schema, base, type);
      case "boolean":
        assertDefaultType(schema, "boolean", path);
        return { ...base, kind: "boolean" };
      case "array":
        return buildArrayNode(schema, base, pathParts, depth, stack);
      default:
        throw unsupported(path, `uses unsupported type '${type}'`);
    }
  } finally {
    stack.delete(schema);
  }
}

function buildChildNode(
  schemaValue: unknown,
  pathParts: readonly string[],
  required: boolean,
  depth: number,
  stack: WeakSet<object>,
): ArgumentSchemaNode {
  try {
    return buildNode(schemaValue, pathParts, required, depth, stack);
  } catch (error) {
    if (!(error instanceof UnsupportedSchemaError)) throw error;
    return buildJsonNode(schemaValue, pathParts, required, error.message);
  }
}

function buildJsonNode(
  schemaValue: unknown,
  pathParts: readonly string[],
  required: boolean,
  fallbackReason: string,
): ArgumentJsonNode {
  const schema = asObject(schemaValue);
  const hasDefault = schema !== undefined && Object.hasOwn(schema, "default");
  const expectedType = isJsonExpectedType(schema?.type) ? schema.type : undefined;
  return {
    kind: "json",
    path: argumentPath(pathParts),
    required,
    hasDefault,
    fallbackReason,
    ...(typeof schema?.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema?.description === "string" ? { description: schema.description } : {}),
    ...(hasDefault ? { defaultValue: schema?.default } : {}),
    ...(expectedType === undefined ? {} : { expectedType }),
  };
}

function buildObjectNode(
  schema: JsonObject,
  base: ArgumentNodeBase,
  pathParts: readonly string[],
  depth: number,
  stack: WeakSet<object>,
): ArgumentObjectNode {
  const propertiesValue = schema.properties ?? {};
  const propertiesObject = asObject(propertiesValue);
  if (!propertiesObject) throw unsupported(base.path, "has non-object properties");

  const requiredNames = readRequiredNames(schema.required, base.path);
  for (const requiredName of requiredNames) {
    if (!Object.hasOwn(propertiesObject, requiredName)) {
      throw unsupported(base.path, `requires undeclared property '${requiredName}'`);
    }
  }

  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    throw unsupported(base.path, "uses a schema-valued additionalProperties constraint");
  }

  const properties = Object.entries(propertiesObject).map(([name, childSchema]) => ({
    name,
    node: buildChildNode(
      childSchema,
      [...pathParts, name],
      requiredNames.has(name),
      depth + 1,
      stack,
    ),
  }));

  if (base.hasDefault && !asObject(base.defaultValue)) {
    throw unsupported(base.path, "has a default that is not an object");
  }

  return {
    ...base,
    kind: "object",
    properties,
    allowAdditionalProperties: additional !== false,
  };
}

function buildStringNode(schema: JsonObject, base: ArgumentNodeBase): ArgumentStringNode {
  const minLength = readNonnegativeInteger(schema.minLength, "minLength", base.path);
  const maxLength = readNonnegativeInteger(schema.maxLength, "maxLength", base.path);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw unsupported(base.path, "has minLength greater than maxLength");
  }

  let enumValues: readonly string[] | undefined;
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      !schema.enum.every((value): value is string => typeof value === "string")
    ) {
      throw unsupported(base.path, "has a non-string or empty enum");
    }
    enumValues = [...new Set(schema.enum)];
  }

  const format = readOptionalString(schema.format, "format", base.path);
  assertDefaultType(schema, "string", base.path);
  if (
    base.hasDefault &&
    enumValues !== undefined &&
    typeof base.defaultValue === "string" &&
    !enumValues.includes(base.defaultValue)
  ) {
    throw unsupported(base.path, "has a default outside its enum");
  }

  return { ...base, kind: "string", enumValues, minLength, maxLength, format };
}

function buildNumberNode(
  schema: JsonObject,
  base: ArgumentNodeBase,
  kind: "number" | "integer",
): ArgumentNumberNode {
  const minimum = readFiniteNumber(schema.minimum, "minimum", base.path);
  const maximum = readFiniteNumber(schema.maximum, "maximum", base.path);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw unsupported(base.path, "has minimum greater than maximum");
  }
  assertDefaultType(schema, "number", base.path);
  if (base.hasDefault && kind === "integer" && !Number.isInteger(base.defaultValue)) {
    throw unsupported(base.path, "has a non-integer default");
  }
  return { ...base, kind, minimum, maximum };
}

function buildArrayNode(
  schema: JsonObject,
  base: ArgumentNodeBase,
  pathParts: readonly string[],
  depth: number,
  stack: WeakSet<object>,
): ArgumentArrayNode {
  if (schema.items === undefined || Array.isArray(schema.items)) {
    throw unsupported(base.path, "must declare one items schema");
  }
  const minItems = readNonnegativeInteger(schema.minItems, "minItems", base.path);
  const maxItems = readNonnegativeInteger(schema.maxItems, "maxItems", base.path);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw unsupported(base.path, "has minItems greater than maxItems");
  }
  if (base.hasDefault && !Array.isArray(base.defaultValue)) {
    throw unsupported(base.path, "has a default that is not an array");
  }
  return {
    ...base,
    kind: "array",
    items: buildChildNode(schema.items, [...pathParts, "*"], true, depth + 1, stack),
    minItems,
    maxItems,
  };
}

function readBaseNode(schema: JsonObject, path: string, required: boolean): ArgumentNodeBase {
  const title = readOptionalString(schema.title, "title", path);
  const description = readOptionalString(schema.description, "description", path);
  const hasDefault = Object.hasOwn(schema, "default");
  return {
    path,
    title,
    description,
    required,
    hasDefault,
    ...(hasDefault ? { defaultValue: schema.default } : {}),
  };
}

function parseRawArguments(
  analysis: ArgumentSchemaAnalysis,
  formData: FormData,
  prefix: string,
): ArgumentParseResult {
  const mode = "raw" as const;
  const raw = readFormString(formData, argumentRawName(prefix));
  if (raw === undefined || raw.trim().length === 0) {
    return {
      success: false,
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Enter a JSON object." },
      mode,
    };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_ARGUMENT_JSON_BYTES) {
    return {
      success: false,
      errors: {
        [RAW_ARGUMENTS_ERROR_PATH]: `Arguments must be no larger than ${String(MAX_ARGUMENT_JSON_BYTES / 1_024)} KiB.`,
      },
      mode,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      success: false,
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Enter valid JSON." },
      mode,
    };
  }
  const object = asObject(value);
  if (!object) {
    return {
      success: false,
      errors: { [RAW_ARGUMENTS_ERROR_PATH]: "Tool arguments must be a JSON object." },
      mode,
    };
  }

  if (analysis.supported) {
    const validationErrors = new Map<string, string>();
    validateValue(analysis.root, value, "", validationErrors);
    const firstError = validationErrors.entries().next().value;
    if (firstError) {
      const [path, message] = firstError;
      return {
        success: false,
        errors: {
          [RAW_ARGUMENTS_ERROR_PATH]: `${displayPath(path)}: ${message}`,
        },
        mode,
      };
    }
  }

  return { success: true, data: object, mode };
}

function parseObjectFields(
  node: ArgumentObjectNode,
  formData: FormData,
  prefix: string,
  errors: Map<string, string>,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const property of node.properties) {
    const child = property.node;
    const included =
      child.required ||
      readFormString(formData, argumentIncludedName(child.path, prefix)) === "true";
    if (!included) continue;

    if (child.kind === "object") {
      entries.push([
        property.name,
        Object.fromEntries(parseObjectFields(child, formData, prefix, errors)),
      ]);
      continue;
    }

    const raw = readFormString(formData, argumentValueName(child.path, prefix));
    const parsed = parseFieldValue(child, raw, errors);
    if (parsed.success) entries.push([property.name, parsed.value]);
  }
  return entries;
}

function parseFieldValue(
  node: Exclude<ArgumentSchemaNode, ArgumentObjectNode>,
  raw: string | undefined,
  errors: Map<string, string>,
): { readonly success: true; readonly value: unknown } | { readonly success: false } {
  if (raw === undefined) {
    addError(errors, node.path, "This field is required.");
    return { success: false };
  }

  let value: unknown = raw;
  if (node.kind === "number" || node.kind === "integer") {
    if (raw.trim().length === 0) {
      addError(errors, node.path, "Enter a number.");
      return { success: false };
    }
    value = Number(raw);
  } else if (node.kind === "boolean") {
    if (raw !== "true" && raw !== "false") {
      addError(errors, node.path, "Choose true or false.");
      return { success: false };
    }
    value = raw === "true";
  } else if (node.kind === "array" || node.kind === "json") {
    if (raw.trim().length === 0) {
      addError(errors, node.path, node.kind === "array" ? "Enter a JSON array." : "Enter JSON.");
      return { success: false };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      addError(
        errors,
        node.path,
        node.kind === "array" ? "Enter a valid JSON array." : "Enter valid JSON.",
      );
      return { success: false };
    }
  }

  const validationErrors = new Map<string, string>();
  validateValue(node, value, node.path, validationErrors);
  const firstError = validationErrors.entries().next().value;
  if (firstError) {
    const [errorPath, message] = firstError;
    addError(
      errors,
      node.path,
      errorPath === node.path ? message : `${displayPath(errorPath)}: ${message}`,
    );
    return { success: false };
  }
  return { success: true, value };
}

function validateValue(
  node: ArgumentSchemaNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  switch (node.kind) {
    case "string":
      validateString(node, value, path, errors);
      return;
    case "number":
    case "integer":
      validateNumber(node, value, path, errors);
      return;
    case "boolean":
      if (typeof value !== "boolean") addError(errors, path, "Expected a boolean.");
      return;
    case "array":
      validateArray(node, value, path, errors);
      return;
    case "json":
      validateJsonNode(node, value, path, errors);
      return;
    case "object":
      validateObject(node, value, path, errors);
  }
}

function validateString(
  node: ArgumentStringNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  if (typeof value !== "string") {
    addError(errors, path, "Expected a string.");
    return;
  }
  const length = Array.from(value).length;
  if (node.minLength !== undefined && length < node.minLength) {
    addError(errors, path, `Use at least ${String(node.minLength)} characters.`);
  } else if (node.maxLength !== undefined && length > node.maxLength) {
    addError(errors, path, `Use no more than ${String(node.maxLength)} characters.`);
  } else if (node.enumValues !== undefined && !node.enumValues.includes(value)) {
    addError(errors, path, "Choose one of the advertised values.");
  } else if (node.format && !matchesFormat(value, node.format)) {
    addError(errors, path, formatError(node.format));
  }
}

function validateNumber(
  node: ArgumentNumberNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addError(errors, path, "Expected a finite number.");
    return;
  }
  if (node.kind === "integer" && !Number.isInteger(value)) {
    addError(errors, path, "Enter a whole number.");
  } else if (node.minimum !== undefined && value < node.minimum) {
    addError(errors, path, `Enter a value of at least ${String(node.minimum)}.`);
  } else if (node.maximum !== undefined && value > node.maximum) {
    addError(errors, path, `Enter a value no greater than ${String(node.maximum)}.`);
  }
}

function validateArray(
  node: ArgumentArrayNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected an array.");
    return;
  }
  if (node.minItems !== undefined && value.length < node.minItems) {
    addError(errors, path, `Add at least ${String(node.minItems)} items.`);
    return;
  }
  if (node.maxItems !== undefined && value.length > node.maxItems) {
    addError(errors, path, `Use no more than ${String(node.maxItems)} items.`);
    return;
  }
  value.forEach((item, index) => {
    validateValue(node.items, item, appendPointer(path, String(index)), errors);
  });
}

function validateJsonNode(
  node: ArgumentJsonNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  switch (node.expectedType) {
    case "object":
      if (!asObject(value)) addError(errors, path, "Expected an object.");
      return;
    case "array":
      if (!Array.isArray(value)) addError(errors, path, "Expected an array.");
      return;
    case "string":
      if (typeof value !== "string") addError(errors, path, "Expected a string.");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        addError(errors, path, "Expected a finite number.");
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        addError(errors, path, "Expected a whole number.");
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") addError(errors, path, "Expected a boolean.");
      return;
    case undefined:
      return;
  }
}

function validateObject(
  node: ArgumentObjectNode,
  value: unknown,
  path: string,
  errors: Map<string, string>,
): void {
  const object = asObject(value);
  if (!object) {
    addError(errors, path, "Expected an object.");
    return;
  }
  const propertyMap = new Map(node.properties.map((property) => [property.name, property.node]));
  for (const property of node.properties) {
    if (!Object.hasOwn(object, property.name)) {
      if (property.node.required) {
        addError(errors, appendPointer(path, property.name), "This field is required.");
      }
      continue;
    }
    validateValue(property.node, object[property.name], appendPointer(path, property.name), errors);
  }
  if (!node.allowAdditionalProperties) {
    for (const key of Object.keys(object)) {
      if (!propertyMap.has(key)) {
        addError(errors, appendPointer(path, key), "This property is not allowed.");
      }
    }
  }
}

function defaultObjectValue(node: ArgumentObjectNode): Record<string, unknown> {
  const objectDefault = asObject(node.defaultValue);
  if (node.hasDefault && objectDefault) {
    return objectDefault;
  }
  const entries: Array<[string, unknown]> = [];
  for (const property of node.properties) {
    const value = defaultNodeValue(property.node);
    if (value.present) entries.push([property.name, value.value]);
  }
  return Object.fromEntries(entries);
}

function defaultNodeValue(
  node: ArgumentSchemaNode,
): { readonly present: true; readonly value: unknown } | { readonly present: false } {
  if (node.hasDefault) return { present: true, value: node.defaultValue };
  if (node.kind === "object") {
    const value = defaultObjectValue(node);
    if (Object.keys(value).length > 0) return { present: true, value };
  }
  return { present: false };
}

function matchesFormat(value: string, format: string): boolean {
  switch (format) {
    case "email":
      return EMAIL_PATTERN.test(value);
    case "uri":
    case "url":
      try {
        void new URL(value);
        return true;
      } catch {
        return false;
      }
    case "uuid":
      return UUID_PATTERN.test(value);
    case "date":
      return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
    case "date-time":
      return DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
    default:
      // JSON Schema formats are annotations by default. Unknown formats remain descriptive.
      return true;
  }
}

function formatError(format: string): string {
  switch (format) {
    case "email":
      return "Enter a valid email address.";
    case "uri":
    case "url":
      return "Enter a valid URL.";
    case "uuid":
      return "Enter a valid UUID.";
    case "date":
      return "Enter a date in YYYY-MM-DD format.";
    case "date-time":
      return "Enter a valid ISO date and time.";
    default:
      return `Enter a value matching the '${format}' format.`;
  }
}

function readRequiredNames(value: unknown, path: string): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw unsupported(path, "has an invalid required list");
  }
  return new Set(value);
}

function readOptionalString(value: unknown, keyword: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw unsupported(path, `has a non-string ${keyword}`);
  return value;
}

function readNonnegativeInteger(value: unknown, keyword: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw unsupported(path, `has an invalid ${keyword}`);
  }
  return value;
}

function readFiniteNumber(value: unknown, keyword: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unsupported(path, `has an invalid ${keyword}`);
  }
  return value;
}

function assertDefaultType(
  schema: JsonObject,
  type: "string" | "number" | "boolean",
  path: string,
) {
  if (Object.hasOwn(schema, "default") && typeof schema.default !== type) {
    throw unsupported(path, `has a default that is not a ${type}`);
  }
}

function readFormString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function addError(errors: Map<string, string>, path: string, message: string): void {
  if (!errors.has(path)) errors.set(path || ROOT_ARGUMENTS_ERROR_PATH, message);
}

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonExpectedType(value: unknown): value is ArgumentJsonExpectedType {
  return (
    value === "object" ||
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "array"
  );
}

function unsupported(path: string, message: string): UnsupportedSchemaError {
  return new UnsupportedSchemaError(`${displayPath(path)} ${message}.`);
}

function displayPath(path: string): string {
  return path.length === 0 ? "The root schema" : path;
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendPointer(path: string, token: string): string {
  return `${path}/${escapeJsonPointerToken(token)}`;
}

function jsonByteLength(value: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
