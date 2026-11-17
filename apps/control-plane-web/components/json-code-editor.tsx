"use client";

import { Braces, WandSparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatJsonDocument } from "@/lib/json-document";
import { cn } from "@/lib/utils";

const LazyCodeMirrorJsonSurface = lazy(async () => {
  const loaded = await import("@/components/codemirror-json-surface");
  return { default: loaded.CodeMirrorJsonSurface };
});

const subscribeToNothing = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export interface JsonCodeEditorProps {
  readonly ariaDescribedBy?: string;
  readonly ariaInvalid?: boolean;
  readonly ariaLabel: string;
  readonly ariaRequired?: boolean;
  readonly className?: string;
  readonly defaultValue?: string;
  readonly disabled?: boolean;
  readonly editorId?: string;
  readonly error?: string;
  readonly maxBytes?: number;
  readonly maxHeight?: string;
  readonly minHeight?: string;
  readonly name?: string;
  readonly onChange?: (value: string) => void;
  readonly readOnly?: boolean;
  readonly showToolbar?: boolean;
  readonly value?: string;
}

export function JsonCodeEditor({
  ariaDescribedBy,
  ariaInvalid = false,
  ariaLabel,
  ariaRequired = false,
  className,
  defaultValue = "",
  disabled = false,
  editorId,
  error,
  maxBytes,
  maxHeight = "20rem",
  minHeight = "7rem",
  name,
  onChange,
  readOnly = false,
  showToolbar = !readOnly,
  value,
}: JsonCodeEditorProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [formatError, setFormatError] = useState<string>();
  const generatedId = useId();
  const hydrated = useSyncExternalStore(subscribeToNothing, getClientSnapshot, getServerSnapshot);
  const controlled = value !== undefined;
  const documentValue = value ?? internalValue;
  const visibleError = error ?? formatError;
  const visibleErrorId = `${editorId ?? `json-code-editor-${generatedId}`}-error`;
  const describedBy = [ariaDescribedBy, visibleError ? visibleErrorId : undefined]
    .filter((item): item is string => item !== undefined)
    .join(" ");

  const handleChange = useCallback(
    (nextValue: string) => {
      setFormatError(undefined);
      if (!controlled) setInternalValue(nextValue);
      onChange?.(nextValue);
    },
    [controlled, onChange],
  );

  function handleFormat() {
    const result = formatJsonDocument(documentValue);
    if (!result.success) {
      setFormatError(result.message);
      return;
    }
    if (maxBytes !== undefined && new TextEncoder().encode(result.value).byteLength > maxBytes) {
      setFormatError("Formatted JSON would exceed this field's size limit.");
      return;
    }
    handleChange(result.value);
  }

  const fallback = (
    <EditorFallback
      ariaDescribedBy={describedBy || undefined}
      ariaInvalid={ariaInvalid || visibleError !== undefined}
      ariaLabel={ariaLabel}
      ariaRequired={ariaRequired}
      disabled={disabled}
      editorId={editorId}
      maxBytes={maxBytes}
      maxHeight={maxHeight}
      minHeight={minHeight}
      onChange={handleChange}
      readOnly={readOnly}
      value={documentValue}
    />
  );

  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border bg-background/80",
        (ariaInvalid || visibleError !== undefined) && "border-destructive",
        disabled && "opacity-55",
        className,
      )}
      data-json-code-editor=""
    >
      {showToolbar ? (
        <div className="flex items-center justify-between gap-1.5 border-b bg-muted/25 px-2 py-1.5 sm:px-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <Braces className="size-3" /> JSON
          </span>
          <Button
            className="h-7 shrink-0 px-1.5 sm:px-2"
            disabled={disabled}
            onClick={handleFormat}
            size="sm"
            type="button"
            variant="ghost"
          >
            <WandSparkles className="size-3" />
            Format
          </Button>
        </div>
      ) : null}

      {name ? <input disabled={disabled} name={name} type="hidden" value={documentValue} /> : null}

      {hydrated ? (
        <Suspense fallback={fallback}>
          <LazyCodeMirrorJsonSurface
            ariaDescribedBy={describedBy || undefined}
            ariaInvalid={ariaInvalid || visibleError !== undefined}
            ariaLabel={ariaLabel}
            ariaRequired={ariaRequired}
            disabled={disabled}
            editorId={editorId}
            maxBytes={maxBytes}
            maxHeight={maxHeight}
            minHeight={minHeight}
            onChange={handleChange}
            readOnly={readOnly}
            value={documentValue}
          />
        </Suspense>
      ) : (
        fallback
      )}

      {visibleError ? (
        <p className="border-t px-3 py-2 text-xs text-destructive" id={visibleErrorId} role="alert">
          {visibleError}
        </p>
      ) : null}
    </div>
  );
}

export function JsonCodeDetails({
  ariaLabel,
  children,
  className,
  code,
  defaultOpen = false,
  maxHeight = "18rem",
  minHeight = "5rem",
  summaryClassName,
}: {
  readonly ariaLabel: string;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly code: string;
  readonly defaultOpen?: boolean;
  readonly maxHeight?: string;
  readonly minHeight?: string;
  readonly summaryClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={cn("group rounded-lg border bg-muted/20", className)}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary
        className={cn(
          "cursor-pointer list-none px-2.5 py-2 text-xs font-medium text-muted-foreground group-open:text-foreground",
          summaryClassName,
        )}
      >
        {children}
      </summary>
      {open ? (
        <JsonCodeEditor
          ariaLabel={ariaLabel}
          className="rounded-none border-x-0 border-b-0"
          maxHeight={maxHeight}
          minHeight={minHeight}
          readOnly
          showToolbar={false}
          value={code}
        />
      ) : (
        <pre
          aria-label={ariaLabel}
          className="max-h-72 overflow-auto border-t p-3 font-mono text-[11px] leading-relaxed whitespace-pre"
        >
          {code}
        </pre>
      )}
    </details>
  );
}

function EditorFallback({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  ariaRequired,
  disabled,
  editorId,
  maxBytes,
  maxHeight,
  minHeight,
  onChange,
  readOnly,
  value,
}: {
  readonly ariaDescribedBy?: string;
  readonly ariaInvalid: boolean;
  readonly ariaLabel: string;
  readonly ariaRequired: boolean;
  readonly disabled: boolean;
  readonly editorId?: string;
  readonly maxBytes?: number;
  readonly maxHeight: string;
  readonly minHeight: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly value: string;
}) {
  if (readOnly) {
    return (
      <pre
        aria-label={ariaLabel}
        className="overflow-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre"
        style={{ maxHeight, minHeight }}
      >
        {value}
      </pre>
    );
  }

  return (
    <Textarea
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      aria-label={ariaLabel}
      aria-required={ariaRequired}
      className="resize-none rounded-none border-0 bg-transparent font-mono text-xs leading-relaxed focus-visible:ring-0"
      disabled={disabled}
      id={editorId}
      maxLength={maxBytes}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      style={{ maxHeight, minHeight }}
      value={value}
    />
  );
}
