import { AlertCircle, CheckCircle2, FileJson2 } from "lucide-react";

import { JsonCodeDetails } from "@/components/json-code-editor";
import { Badge } from "@/components/ui/badge";
import type { ToolCallResult, ToolResultContent } from "@/lib/control-plane-api";

const MAX_CONTENT_BLOCKS = 50;
const MAX_TEXT_CHARACTERS = 64 * 1_024;
const MAX_JSON_STRING_CHARACTERS = 16 * 1_024;
const MAX_JSON_COLLECTION_ITEMS = 100;
const MAX_JSON_DEPTH = 8;

export function ToolResultView({ result }: { readonly result: ToolCallResult }) {
  const failed = result.isError === true;
  const visibleContent = result.content.slice(0, MAX_CONTENT_BLOCKS);

  return (
    <section
      aria-label="Tool result"
      aria-live="polite"
      className={
        failed
          ? "rounded-xl border border-destructive/25 bg-destructive/5"
          : "rounded-xl border bg-muted/15"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {failed ? (
            <AlertCircle className="size-4 text-destructive" />
          ) : (
            <CheckCircle2 className="size-4 text-success" />
          )}
          {failed ? "Tool reported an error" : "Tool completed"}
        </div>
        <Badge variant={failed ? "destructive" : "success"}>
          {result.content.length} content {result.content.length === 1 ? "block" : "blocks"}
        </Badge>
      </div>

      <div className="grid max-h-[42vh] gap-3 overflow-y-auto p-4">
        {result.content.length === 0 ? (
          <p className="text-sm text-muted-foreground">The tool returned no content blocks.</p>
        ) : (
          visibleContent.map((content, index) => (
            <ToolContentBlock content={content} index={index} key={contentKey(content, index)} />
          ))
        )}

        {result.content.length > visibleContent.length ? (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground">
            {String(result.content.length - visibleContent.length)} additional content blocks are
            omitted from the rendered preview. The bounded raw response below summarizes them.
          </p>
        ) : null}

        {result.structuredContent === undefined ? null : (
          <JsonResult label="Structured content" value={result.structuredContent} />
        )}

        <JsonCodeDetails
          ariaLabel="Raw tool response JSON"
          className="bg-background/60"
          code={formatJson(result)}
          summaryClassName="flex items-center gap-2 px-3"
        >
          <FileJson2 className="size-3.5" />
          Raw response
        </JsonCodeDetails>
      </div>
    </section>
  );
}

function ToolContentBlock({
  content,
  index,
}: {
  readonly content: ToolResultContent;
  readonly index: number;
}) {
  if (content.type === "text" && typeof content.text === "string") {
    return (
      <article className="rounded-lg border bg-background/80">
        <ContentHeading index={index} type="Text" />
        <pre className="max-h-80 overflow-auto p-3 text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
          {truncateText(content.text)}
        </pre>
      </article>
    );
  }

  if (content.type === "resource" && isRecord(content.resource)) {
    const resource = content.resource;
    return (
      <article className="rounded-lg border bg-background/80">
        <ContentHeading index={index} type="Embedded resource" />
        <div className="grid gap-2 p-3">
          {typeof resource.uri === "string" ? (
            <code className="break-all text-xs text-muted-foreground">{resource.uri}</code>
          ) : null}
          {typeof resource.text === "string" ? (
            <pre className="max-h-72 overflow-auto text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
              {truncateText(resource.text)}
            </pre>
          ) : (
            <BinarySummary value={resource} />
          )}
        </div>
      </article>
    );
  }

  if (content.type === "resource_link") {
    return (
      <article className="rounded-lg border bg-background/80">
        <ContentHeading index={index} type="Resource link" />
        <dl className="grid gap-1 p-3 text-xs">
          <ResultProperty label="Name" value={content.name} />
          <ResultProperty label="URI" value={content.uri} />
          <ResultProperty label="Media type" value={content.mimeType} />
        </dl>
      </article>
    );
  }

  if (content.type === "image" || content.type === "audio") {
    return (
      <article className="rounded-lg border bg-background/80">
        <ContentHeading index={index} type={content.type === "image" ? "Image" : "Audio"} />
        <div className="grid gap-1 p-3 text-xs">
          <ResultProperty label="Media type" value={content.mimeType} />
          <ResultProperty
            label="Encoded data"
            value={
              typeof content.data === "string"
                ? `${formatBytes(content.data.length)} base64 payload`
                : undefined
            }
          />
          <p className="mt-1 text-muted-foreground">
            Binary output is summarized rather than embedded into this administrative page.
          </p>
        </div>
      </article>
    );
  }

  return <JsonResult label={`Content ${String(index + 1)} · ${content.type}`} value={content} />;
}

function ContentHeading({ index, type }: { readonly index: number; readonly type: string }) {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2">
      <span className="text-xs font-medium">{type}</span>
      <Badge variant="mono">#{index + 1}</Badge>
    </div>
  );
}

function JsonResult({ label, value }: { readonly label: string; readonly value: unknown }) {
  return (
    <JsonCodeDetails
      ariaLabel={`${label} JSON`}
      className="bg-background/60"
      code={formatJson(value)}
      defaultOpen
      summaryClassName="px-3"
    >
      {label}
    </JsonCodeDetails>
  );
}

function BinarySummary({ value }: { readonly value: Record<string, unknown> }) {
  const blob = value.blob;
  return (
    <p className="text-xs text-muted-foreground">
      {typeof blob === "string"
        ? `${formatBytes(blob.length)} encoded resource payload`
        : "Resource has no text preview."}
    </p>
  );
}

function ResultProperty({ label, value }: { readonly label: string; readonly value: unknown }) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return (
    <div className="grid min-w-0 grid-cols-[5rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{String(value)}</dd>
    </div>
  );
}

function contentKey(content: ToolResultContent, index: number): string {
  if (content.type === "resource_link" && typeof content.uri === "string") {
    return `${content.type}:${content.uri}`;
  }
  return `${content.type}:${String(index)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(toDisplayValue(value, 0, { remaining: 1_000 }), null, 2);
  } catch {
    return "[Unable to serialize result]";
  }
}

function toDisplayValue(value: unknown, depth: number, budget: { remaining: number }): unknown {
  if (typeof value === "string") return truncateText(value, MAX_JSON_STRING_CHARACTERS);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_JSON_DEPTH) return "[Nested value omitted]";
  if (budget.remaining <= 0) return "[Preview budget exhausted]";
  budget.remaining -= 1;

  if (Array.isArray(value)) {
    const visible = value
      .slice(0, MAX_JSON_COLLECTION_ITEMS)
      .map((item) => toDisplayValue(item, depth + 1, budget));
    if (value.length > visible.length) {
      visible.push(`[${String(value.length - visible.length)} array items omitted]`);
    }
    return visible;
  }

  const output: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_JSON_COLLECTION_ITEMS)) {
    output[key] = toDisplayValue((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  if (keys.length > MAX_JSON_COLLECTION_ITEMS) {
    output["…"] = `${String(keys.length - MAX_JSON_COLLECTION_ITEMS)} properties omitted`;
  }
  return output;
}

function truncateText(value: string, limit = MAX_TEXT_CHARACTERS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[${String(value.length - limit)} characters omitted]`;
}

function formatBytes(characters: number): string {
  if (characters < 1_024) return `${String(characters)} B`;
  if (characters < 1_048_576) return `${(characters / 1_024).toFixed(1)} KB`;
  return `${(characters / 1_048_576).toFixed(1)} MB`;
}
