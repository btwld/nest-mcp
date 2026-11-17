import { BookOpenText, FileJson2, MessageSquareText } from "lucide-react";

import { JsonCodeDetails } from "@/components/json-code-editor";
import { Badge } from "@/components/ui/badge";
import type {
  GetPromptResult,
  PromptMessage,
  ReadResourceResult,
  ToolResultContent,
} from "@/lib/control-plane-api";

const MAX_RESULT_ITEMS = 50;
const MAX_TEXT_CHARACTERS = 64 * 1_024;
const MAX_JSON_STRING_CHARACTERS = 16 * 1_024;
const MAX_JSON_COLLECTION_ITEMS = 100;
const MAX_JSON_DEPTH = 8;
const MAX_RAW_JSON_CHARACTERS = 64 * 1_024;

export function ResourceReadResultView({ result }: { readonly result: ReadResourceResult }) {
  const visibleContents = result.contents.slice(0, MAX_RESULT_ITEMS);
  return (
    <ResultShell
      count={result.contents.length}
      countLabel={result.contents.length === 1 ? "content item" : "content items"}
      icon={<BookOpenText />}
      label="Resource read completed"
      raw={result}
    >
      {result.contents.length === 0 ? (
        <p className="text-sm text-muted-foreground">The resource returned no content.</p>
      ) : (
        visibleContents.map((content, index) => (
          <ResourceContentItem
            content={content}
            index={index}
            key={`${content.uri}:${String(index)}`}
          />
        ))
      )}
      <OmittedItems total={result.contents.length} visible={visibleContents.length} />
    </ResultShell>
  );
}

export function PromptGetResultView({ result }: { readonly result: GetPromptResult }) {
  const visibleMessages = result.messages.slice(0, MAX_RESULT_ITEMS);
  return (
    <ResultShell
      count={result.messages.length}
      countLabel={result.messages.length === 1 ? "message" : "messages"}
      icon={<MessageSquareText />}
      label="Prompt rendered"
      raw={result}
    >
      {result.description ? (
        <p className="rounded-lg border bg-background/70 p-3 text-xs leading-relaxed text-muted-foreground">
          {truncateText(result.description, 4_096)}
        </p>
      ) : null}
      {result.messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">The prompt returned no messages.</p>
      ) : (
        visibleMessages.map((message, index) => (
          <PromptMessageItem
            index={index}
            key={`${message.role}:${String(index)}`}
            message={message}
          />
        ))
      )}
      <OmittedItems total={result.messages.length} visible={visibleMessages.length} />
    </ResultShell>
  );
}

function ResultShell({
  label,
  icon,
  count,
  countLabel,
  raw,
  children,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly count: number;
  readonly countLabel: string;
  readonly raw: unknown;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-live="polite" className="rounded-xl border bg-muted/15">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-success">
          {icon}
          {label}
        </div>
        <Badge variant="success">
          {count} {countLabel}
        </Badge>
      </div>
      <div className="grid max-h-[42vh] gap-3 overflow-y-auto p-4">
        {children}
        <JsonCodeDetails
          ariaLabel="Bounded raw capability response JSON"
          className="bg-background/60"
          code={formatBoundedJson(raw)}
          summaryClassName="flex items-center gap-2 px-3"
        >
          <FileJson2 className="size-3.5" />
          Bounded raw response
        </JsonCodeDetails>
      </div>
    </section>
  );
}

function ResourceContentItem({
  content,
  index,
}: {
  readonly content: ReadResourceResult["contents"][number];
  readonly index: number;
}) {
  return (
    <article className="rounded-lg border bg-background/80">
      <ContentHeading
        index={index}
        label={content.text === undefined ? "Binary resource" : "Text resource"}
      />
      <div className="grid gap-2 p-3">
        <code className="break-all text-xs text-muted-foreground">{content.uri}</code>
        {content.mimeType ? <Badge variant="outline">{content.mimeType}</Badge> : null}
        {content.text === undefined ? null : (
          <pre className="max-h-72 overflow-auto text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
            {truncateText(content.text)}
          </pre>
        )}
        {content.blob === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            {formatBytes(content.blob.length)} encoded payload. Binary data is summarized rather
            than embedded in this administrative page.
          </p>
        )}
      </div>
    </article>
  );
}

function PromptMessageItem({
  message,
  index,
}: {
  readonly message: PromptMessage;
  readonly index: number;
}) {
  return (
    <article className="rounded-lg border bg-background/80">
      <ContentHeading index={index} label={message.role === "assistant" ? "Assistant" : "User"} />
      <div className="p-3">
        <PromptContentBlock content={message.content} />
      </div>
    </article>
  );
}

function PromptContentBlock({ content }: { readonly content: ToolResultContent }) {
  if (content.type === "text" && typeof content.text === "string") {
    return (
      <pre className="max-h-80 overflow-auto text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
        {truncateText(content.text)}
      </pre>
    );
  }

  if ((content.type === "image" || content.type === "audio") && typeof content.data === "string") {
    return (
      <div className="grid gap-1 text-xs text-muted-foreground">
        <span>{typeof content.mimeType === "string" ? content.mimeType : "Binary content"}</span>
        <span>{formatBytes(content.data.length)} encoded payload</span>
        <span>Binary data is summarized rather than embedded.</span>
      </div>
    );
  }

  if (content.type === "resource" && isRecord(content.resource)) {
    const resource = content.resource;
    return (
      <div className="grid gap-2">
        {typeof resource.uri === "string" ? (
          <code className="break-all text-xs text-muted-foreground">{resource.uri}</code>
        ) : null}
        {typeof resource.text === "string" ? (
          <pre className="max-h-72 overflow-auto text-sm leading-relaxed whitespace-pre-wrap break-words font-sans">
            {truncateText(resource.text)}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            {typeof resource.blob === "string"
              ? `${formatBytes(resource.blob.length)} encoded resource payload`
              : "Embedded resource has no text preview."}
          </p>
        )}
      </div>
    );
  }

  if (content.type === "resource_link") {
    return (
      <dl className="grid gap-1 text-xs">
        <ResultProperty label="Name" value={content.name} />
        <ResultProperty label="URI" value={content.uri} />
        <ResultProperty label="Media type" value={content.mimeType} />
      </dl>
    );
  }

  return (
    <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
      {formatBoundedJson(content)}
    </pre>
  );
}

function ContentHeading({ index, label }: { readonly index: number; readonly label: string }) {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2">
      <span className="text-xs font-medium">{label}</span>
      <Badge variant="mono">#{index + 1}</Badge>
    </div>
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

function OmittedItems({ total, visible }: { readonly total: number; readonly visible: number }) {
  if (total <= visible) return null;
  return (
    <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground">
      {String(total - visible)} additional items are omitted from the rendered preview.
    </p>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBoundedJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(toDisplayValue(value, 0, { remaining: 1_000 }), null, 2);
    return truncateRawJson(serialized);
  } catch {
    return "[Unable to serialize result]";
  }
}

function truncateRawJson(value: string): string {
  if (value.length <= MAX_RAW_JSON_CHARACTERS) return value;
  const suffix = "\n[Additional JSON preview characters omitted]";
  return `${value.slice(0, MAX_RAW_JSON_CHARACTERS - suffix.length)}${suffix}`;
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

  const output = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_JSON_COLLECTION_ITEMS)) {
    const propertyValue = (value as Record<string, unknown>)[key];
    output[key] =
      (key === "blob" || key === "data") && typeof propertyValue === "string"
        ? `[${formatBytes(propertyValue.length)} encoded payload omitted]`
        : toDisplayValue(propertyValue, depth + 1, budget);
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
