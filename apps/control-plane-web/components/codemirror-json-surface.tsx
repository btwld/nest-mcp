"use client";

import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import CodeMirror, {
  EditorState,
  EditorView,
  type Extension,
  type ReactCodeMirrorRef,
  type ViewUpdate,
} from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef } from "react";

const JSON_LANGUAGE = json();
const JSON_LINTER = linter(jsonParseLinter());

const BASIC_SETUP = {
  autocompletion: false,
  closeBrackets: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  lineNumbers: true,
  rectangularSelection: false,
} as const;

export interface CodeMirrorJsonSurfaceProps {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly ariaLabel: string;
  readonly ariaDescribedBy?: string;
  readonly ariaInvalid?: boolean;
  readonly ariaRequired?: boolean;
  readonly disabled?: boolean;
  readonly editorId?: string;
  readonly maxBytes?: number;
  readonly minHeight?: string;
  readonly maxHeight?: string;
  readonly readOnly?: boolean;
}

export function CodeMirrorJsonSurface({
  value,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid = false,
  ariaRequired = false,
  disabled = false,
  editorId,
  maxBytes,
  minHeight = "7rem",
  maxHeight = "20rem",
  readOnly = false,
}: CodeMirrorJsonSurfaceProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const locked = readOnly || disabled;
  const basicSetup = useMemo(
    () => ({
      ...BASIC_SETUP,
      closeBrackets: !locked,
      highlightActiveLine: !locked,
      highlightActiveLineGutter: !locked,
    }),
    [locked],
  );
  const extensions = useMemo(() => {
    const base: Extension[] = [JSON_LANGUAGE, EditorView.lineWrapping];
    if (!readOnly) base.push(JSON_LINTER);
    if (maxBytes === undefined) return base;
    return [
      ...base,
      EditorState.changeFilter.of(
        (transaction) =>
          !transaction.docChanged ||
          new TextEncoder().encode(transaction.newDoc.toString()).byteLength <= maxBytes,
      ),
    ];
  }, [maxBytes, readOnly]);

  const synchronizeAccessibility = useCallback(
    (content: HTMLElement) => {
      if (editorId) content.id = editorId;
      content.setAttribute("aria-label", ariaLabel);
      setOptionalAttribute(content, "aria-describedby", ariaDescribedBy);
      setOptionalAttribute(content, "aria-invalid", ariaInvalid ? "true" : undefined);
      setOptionalAttribute(content, "aria-required", ariaRequired ? "true" : undefined);
      setOptionalAttribute(content, "tabindex", readOnly ? "0" : undefined);
    },
    [ariaDescribedBy, ariaInvalid, ariaLabel, ariaRequired, editorId, readOnly],
  );

  useEffect(() => {
    const content = editorRef.current?.view?.contentDOM;
    if (content) synchronizeAccessibility(content);
  }, [synchronizeAccessibility]);

  const handleUpdate = useCallback(
    (update: ViewUpdate) => {
      if (update.docChanged) onChange?.(update.state.doc.toString());
    },
    [onChange],
  );

  return (
    <CodeMirror
      basicSetup={basicSetup}
      className="json-code-mirror"
      editable={!locked}
      extensions={extensions}
      indentWithTab={false}
      maxHeight={maxHeight}
      minHeight={minHeight}
      onCreateEditor={(view) => synchronizeAccessibility(view.contentDOM)}
      onUpdate={handleUpdate}
      readOnly={locked}
      ref={editorRef}
      theme="none"
      value={value}
    />
  );
}

function setOptionalAttribute(element: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
