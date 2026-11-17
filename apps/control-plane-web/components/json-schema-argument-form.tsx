"use client";

import { useMemo, useState } from "react";
import { Braces, ListTree } from "lucide-react";
import {
  RAW_ARGUMENTS_ERROR_PATH,
  ROOT_ARGUMENTS_ERROR_PATH,
  MAX_ARGUMENT_JSON_BYTES,
  analyzeArgumentSchema,
  argumentIncludedName,
  argumentModeName,
  argumentRawName,
  argumentValueName,
  createDefaultArguments,
  type ArgumentFieldErrors,
  type ArgumentObjectNode,
  type ArgumentProperty,
  type ArgumentSchemaAnalysis,
  type ArgumentSchemaNode,
} from "@/lib/json-schema-arguments";

import { JsonCodeEditor } from "@/components/json-code-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface JsonSchemaArgumentFormProps {
  readonly schema: unknown;
  readonly errors?: ArgumentFieldErrors;
  readonly prefix?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function JsonSchemaArgumentForm({
  schema,
  errors = {},
  prefix = "tool-arguments",
  disabled = false,
  className,
}: JsonSchemaArgumentFormProps) {
  const analysis = useMemo(() => analyzeArgumentSchema(schema), [schema]);
  const schemaKey = useMemo(() => getSchemaKey(schema), [schema]);
  return (
    <ArgumentFormContent
      analysis={analysis}
      className={className}
      disabled={disabled}
      errors={errors}
      key={schemaKey}
      prefix={prefix}
      schema={schema}
    />
  );
}

function ArgumentFormContent({
  schema,
  analysis,
  errors,
  prefix,
  disabled,
  className,
}: {
  readonly schema: unknown;
  readonly analysis: ArgumentSchemaAnalysis;
  readonly errors: ArgumentFieldErrors;
  readonly prefix: string;
  readonly disabled: boolean;
  readonly className?: string;
}) {
  const [preferredMode, setPreferredMode] = useState<"fields" | "raw">(
    analysis.supported ? "fields" : "raw",
  );
  const [rawValue, setRawValue] = useState(() =>
    JSON.stringify(createDefaultArguments(schema), null, 2),
  );
  const mode = analysis.supported ? preferredMode : "raw";

  return (
    <div className={cn("grid gap-4", className)}>
      <input name={argumentModeName(prefix)} type="hidden" value={mode} />

      {analysis.supported ? (
        <div
          className="flex w-fit rounded-lg border bg-muted/35 p-0.5"
          role="group"
          aria-label="Argument editor mode"
        >
          <Button
            aria-pressed={mode === "fields"}
            disabled={disabled}
            onClick={() => setPreferredMode("fields")}
            size="sm"
            type="button"
            variant={mode === "fields" ? "secondary" : "ghost"}
          >
            <ListTree />
            Form
          </Button>
          <Button
            aria-pressed={mode === "raw"}
            disabled={disabled}
            onClick={() => setPreferredMode("raw")}
            size="sm"
            type="button"
            variant={mode === "raw" ? "secondary" : "ghost"}
          >
            <Braces />
            Raw JSON
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-warning/30 bg-warning/7 p-3 text-xs leading-relaxed text-warning-foreground">
          <p className="font-medium">Raw JSON required</p>
          <p className="mt-1 opacity-85">{analysis.reason}</p>
        </div>
      )}

      {analysis.supported ? (
        <div hidden={mode !== "fields"}>
          {analysis.root.properties.length > 0 ? (
            <div className="grid gap-3 sm:gap-4">
              {analysis.root.properties.map((property) => (
                <SchemaPropertyField
                  depth={0}
                  disabled={disabled}
                  errors={errors}
                  key={property.node.path}
                  prefix={prefix}
                  property={property}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed bg-muted/20 p-5 text-center text-sm text-muted-foreground">
              This tool accepts an empty argument object.
            </div>
          )}
        </div>
      ) : null}

      {errors[ROOT_ARGUMENTS_ERROR_PATH] ? (
        <p className="text-xs text-destructive" role="alert">
          {errors[ROOT_ARGUMENTS_ERROR_PATH]}
        </p>
      ) : null}

      {mode === "raw" ? (
        <div className="grid gap-2">
          <Label htmlFor={`${prefix}-raw-json`}>Arguments JSON</Label>
          <JsonCodeEditor
            ariaDescribedBy={`${prefix}-raw-json-hint${errors[RAW_ARGUMENTS_ERROR_PATH] ? ` ${prefix}-raw-json-error` : ""}`}
            ariaInvalid={errors[RAW_ARGUMENTS_ERROR_PATH] !== undefined}
            ariaLabel="Tool arguments as JSON"
            disabled={disabled}
            editorId={`${prefix}-raw-json`}
            maxBytes={MAX_ARGUMENT_JSON_BYTES}
            minHeight="12rem"
            name={argumentRawName(prefix)}
            onChange={setRawValue}
            value={rawValue}
          />
          {errors[RAW_ARGUMENTS_ERROR_PATH] ? (
            <p className="text-xs text-destructive" id={`${prefix}-raw-json-error`}>
              {errors[RAW_ARGUMENTS_ERROR_PATH]}
            </p>
          ) : null}
          <p
            className="text-xs leading-relaxed text-muted-foreground"
            id={`${prefix}-raw-json-hint`}
          >
            Provide one JSON object. Syntax is checked while you edit, and the value is parsed as
            data—never evaluated as code.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SchemaPropertyField({
  property,
  prefix,
  errors,
  disabled,
  depth,
  wide = false,
}: {
  readonly property: ArgumentProperty;
  readonly prefix: string;
  readonly errors: ArgumentFieldErrors;
  readonly disabled: boolean;
  readonly depth: number;
  readonly wide?: boolean;
}) {
  const node = property.node;
  const initiallyIncluded = node.required || node.hasDefault || hasNestedDefaults(node);
  const [included, setIncluded] = useState(initiallyIncluded);
  const fieldDisabled = disabled || !included;
  const inputId = fieldId(prefix, node.path);
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const error = errors[node.path];
  const hint = fieldHintText(node);
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ");
  const isRootSection = depth === 0;
  const isObject = node.kind === "object";
  const spansGrid = wide || isObject || node.kind === "array" || node.kind === "json";

  return (
    <fieldset
      aria-describedby={isObject && describedBy ? describedBy : undefined}
      data-included={included}
      data-schema-depth={depth}
      data-schema-kind={node.kind}
      data-schema-path={node.path}
      className={cn(
        "min-w-0",
        isRootSection
          ? "overflow-hidden rounded-xl border bg-card/35 shadow-sm"
          : isObject
            ? "rounded-lg border bg-muted/15 p-2.5 sm:p-3"
            : "grid content-start gap-2 border-b border-border/60 py-3",
        !isRootSection && spansGrid && "md:col-span-2",
        !included && isRootSection && "bg-muted/15",
        !included && !isRootSection && "text-muted-foreground",
      )}
    >
      <legend className="sr-only">{node.title ?? property.name}</legend>
      <div
        className={cn(
          "flex min-w-0 items-start justify-between gap-3",
          isRootSection && "px-3 py-3 sm:px-4",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isObject ? (
            <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
              {node.title ?? property.name}
              {node.required ? (
                <span aria-hidden="true" className="ml-1 text-destructive">
                  *
                </span>
              ) : null}
            </span>
          ) : (
            <Label className="min-w-0 [overflow-wrap:anywhere]" htmlFor={inputId}>
              {node.title ?? property.name}
              {node.required ? (
                <span aria-hidden="true" className="ml-1 text-destructive">
                  *
                </span>
              ) : null}
            </Label>
          )}
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
            {nodeTypeLabel(node)}
          </span>
        </div>
        {node.required ? (
          <span className="mt-0.5 shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Required
          </span>
        ) : (
          <label className="flex h-7 shrink-0 items-center gap-2 rounded-full border bg-background px-2.5 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground">
            <input
              aria-controls={`${inputId}-body`}
              aria-label={`Include ${node.title ?? property.name}`}
              checked={included}
              className="size-3.5 accent-[var(--primary)]"
              disabled={disabled}
              id={`${inputId}-included`}
              name={argumentIncludedName(node.path, prefix)}
              onChange={(event) => setIncluded(event.target.checked)}
              type="checkbox"
              value="true"
            />
            Include
          </label>
        )}
      </div>

      <div
        className={cn(
          "grid gap-2",
          isRootSection && "border-t bg-background px-3 py-1 sm:px-4",
          !isRootSection && isObject && "mt-3 border-t pt-1",
        )}
        hidden={!included}
        id={`${inputId}-body`}
      >
        {isObject && hint ? <FieldHint id={hintId} text={hint} /> : null}
        {node.kind === "object" ? (
          <ObjectFields
            depth={depth}
            disabled={fieldDisabled}
            errors={errors}
            node={node}
            prefix={prefix}
          />
        ) : (
          <PrimitiveField
            describedBy={describedBy || undefined}
            disabled={fieldDisabled}
            id={inputId}
            invalid={error !== undefined}
            node={node}
            prefix={prefix}
          />
        )}

        {!isObject && hint ? <FieldHint id={hintId} text={hint} /> : null}
        {error ? (
          <p className="text-xs text-destructive" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function ObjectFields({
  node,
  prefix,
  errors,
  disabled,
  depth,
}: {
  readonly node: ArgumentObjectNode;
  readonly prefix: string;
  readonly errors: ArgumentFieldErrors;
  readonly disabled: boolean;
  readonly depth: number;
}) {
  if (node.properties.length === 0) {
    return <p className="text-xs text-muted-foreground">Empty object</p>;
  }
  return (
    <div className="grid min-w-0 gap-x-4 md:grid-cols-2">
      {node.properties.map((property) => (
        <SchemaPropertyField
          depth={depth + 1}
          disabled={disabled}
          errors={errors}
          key={property.node.path}
          prefix={prefix}
          property={property}
          wide={node.properties.length === 1}
        />
      ))}
    </div>
  );
}

function PrimitiveField({
  node,
  prefix,
  id,
  disabled,
  invalid,
  describedBy,
}: {
  readonly node: Exclude<ArgumentSchemaNode, ArgumentObjectNode>;
  readonly prefix: string;
  readonly id: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy?: string;
}) {
  const common = {
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    "aria-required": node.required,
    disabled,
    id,
    name: argumentValueName(node.path, prefix),
  } as const;

  if (node.kind === "string" && node.enumValues) {
    return (
      <select
        {...common}
        className="h-9 w-full min-w-0 rounded-lg border border-transparent bg-input/50 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
        defaultValue={node.hasDefault ? String(node.defaultValue) : ""}
      >
        <option value="">Choose a value…</option>
        {node.enumValues.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    );
  }

  if (node.kind === "boolean") {
    return (
      <select
        {...common}
        className="h-9 w-full min-w-0 rounded-lg border border-transparent bg-input/50 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
        defaultValue={node.hasDefault ? String(node.defaultValue) : ""}
      >
        <option value="">Choose true or false…</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (node.kind === "json") {
    return (
      <JsonCodeEditor
        ariaDescribedBy={describedBy}
        ariaInvalid={invalid}
        ariaLabel={`JSON value for ${node.title ?? node.path}`}
        ariaRequired={node.required}
        defaultValue={jsonNodeDefaultValue(node)}
        disabled={disabled}
        editorId={id}
        maxBytes={MAX_ARGUMENT_JSON_BYTES}
        maxHeight="14rem"
        minHeight="7rem"
        name={argumentValueName(node.path, prefix)}
      />
    );
  }

  if (node.kind === "array") {
    return (
      <JsonCodeEditor
        ariaDescribedBy={describedBy}
        ariaInvalid={invalid}
        ariaLabel={`JSON array for ${node.title ?? node.path}`}
        ariaRequired={node.required}
        defaultValue={node.hasDefault ? JSON.stringify(node.defaultValue, null, 2) : "[]"}
        disabled={disabled}
        editorId={id}
        maxBytes={MAX_ARGUMENT_JSON_BYTES}
        maxHeight="14rem"
        minHeight="7rem"
        name={argumentValueName(node.path, prefix)}
      />
    );
  }

  if (node.kind === "number" || node.kind === "integer") {
    return (
      <Input
        {...common}
        defaultValue={node.hasDefault ? String(node.defaultValue) : ""}
        max={node.maximum}
        min={node.minimum}
        step={node.kind === "integer" ? 1 : "any"}
        type="number"
      />
    );
  }

  if (node.kind === "string") {
    return (
      <Input
        {...common}
        defaultValue={node.hasDefault ? String(node.defaultValue) : ""}
        maxLength={node.maxLength}
        minLength={node.minLength}
        type={inputTypeForFormat(node.format)}
      />
    );
  }

  return null;
}

function FieldHint({ text, id }: { readonly text: string; readonly id: string }) {
  return (
    <p
      className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
      id={id}
    >
      {text}
    </p>
  );
}

function fieldHintText(node: ArgumentSchemaNode): string | undefined {
  const description = node.description?.trim();
  const constraints = constraintDescription(node);
  if (description && constraints) return `${description} · ${constraints}`;
  return description || constraints;
}

function constraintDescription(node: ArgumentSchemaNode): string | undefined {
  if (node.kind === "string") {
    const parts = [
      node.format ? `format: ${node.format}` : undefined,
      node.minLength !== undefined ? `min ${String(node.minLength)} chars` : undefined,
      node.maxLength !== undefined ? `max ${String(node.maxLength)} chars` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (node.kind === "number" || node.kind === "integer") {
    const parts = [
      node.kind === "integer" ? "whole number" : undefined,
      node.minimum !== undefined ? `min ${String(node.minimum)}` : undefined,
      node.maximum !== undefined ? `max ${String(node.maximum)}` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (node.kind === "array") {
    const parts = [
      "JSON array",
      node.items.kind === "json" ? "complex items stay in JSON" : undefined,
      node.minItems !== undefined ? `min ${String(node.minItems)} items` : undefined,
      node.maxItems !== undefined ? `max ${String(node.maxItems)} items` : undefined,
    ].filter(Boolean);
    return parts.join(", ");
  }
  if (node.kind === "json") {
    return node.expectedType
      ? `JSON ${node.expectedType} · complex schema validated when run`
      : "JSON value · complex schema validated when run";
  }
  return undefined;
}

function nodeTypeLabel(node: ArgumentSchemaNode): string {
  if (node.kind === "object") {
    const count = node.properties.length;
    return `object · ${String(count)} ${count === 1 ? "field" : "fields"}`;
  }
  if (node.kind === "array") return "JSON array";
  if (node.kind === "json") return node.expectedType ? `JSON ${node.expectedType}` : "JSON";
  if (node.kind === "integer") return "integer";
  return node.kind;
}

function hasNestedDefaults(node: ArgumentSchemaNode): boolean {
  return (
    node.kind === "object" &&
    node.properties.some((property) => property.node.hasDefault || hasNestedDefaults(property.node))
  );
}

function inputTypeForFormat(format: string | undefined): "text" | "email" | "url" | "date" {
  if (format === "email") return "email";
  if (format === "uri" || format === "url") return "url";
  if (format === "date") return "date";
  return "text";
}

function jsonNodeDefaultValue(node: Extract<ArgumentSchemaNode, { kind: "json" }>): string {
  if (!node.hasDefault) return "";
  try {
    return JSON.stringify(node.defaultValue, null, 2) ?? "";
  } catch {
    return "";
  }
}

function fieldId(prefix: string, path: string): string {
  return `${prefix}-field-${encodeURIComponent(path)}`;
}

function getSchemaKey(schema: unknown): string {
  try {
    return JSON.stringify(schema) ?? "undefined-schema";
  } catch {
    return "unserializable-schema";
  }
}
