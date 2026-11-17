"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText, Play, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PromptGetResultView } from "@/components/capability-result-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getApiErrorMessage, type Connection, type Prompt } from "@/lib/control-plane-api";
import { controlPlaneKeys, promptGetMutationOptions } from "@/lib/control-plane-queries";
import {
  MAX_PROMPT_ARGUMENTS,
  MAX_PROMPT_ARGUMENT_CHARACTERS,
  PROMPT_ARGUMENT_ROOT_ERROR,
  parsePromptArguments,
  promptArgumentIncludedName,
  promptArgumentValueName,
  type PromptArgumentErrors,
} from "@/lib/prompt-arguments";

export function PromptGetDialog({
  connection,
  prompt,
  onDismiss,
}: {
  readonly connection: Connection;
  readonly prompt: Prompt;
  readonly onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<PromptArgumentErrors>({});
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const mutation = useMutation({
    ...promptGetMutationOptions(connection.id),
    onSuccess: () => {
      toast.success("Prompt rendered", { description: prompt.title ?? prompt.name });
    },
    onError: (error) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      ]);
      toast.error("Prompt request failed", { description: getApiErrorMessage(error) });
    },
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parsePromptArguments(prompt, new FormData(event.currentTarget));
    if (!parsed.success) {
      setFieldErrors(parsed.errors);
      return;
    }

    setFieldErrors({});
    mutation.reset();
    try {
      await mutation.mutateAsync(
        parsed.data === undefined
          ? { name: prompt.name }
          : { name: prompt.name, arguments: parsed.data },
      );
    } catch {
      // The mutation renders the typed API error and preserves form values for correction.
    }
  }

  const definitions = prompt.arguments ?? [];
  const visibleDefinitions = definitions.slice(0, MAX_PROMPT_ARGUMENTS);

  return (
    <Dialog onOpenChange={(open) => (!open && !mutation.isPending ? onDismiss() : undefined)} open>
      <DialogContent className="max-w-3xl">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant="mono">
                <MessageSquareText className="size-3" /> Prompt
              </Badge>
              <Badge variant="outline">
                {definitions.length} {definitions.length === 1 ? "argument" : "arguments"}
              </Badge>
            </div>
            <DialogTitle>Render {prompt.title ?? prompt.name}</DialogTitle>
            <DialogDescription>
              Get <span className="font-mono text-foreground">{prompt.name}</span> from{" "}
              {connection.displayName}. Every request is explicit and is never retried
              automatically.
            </DialogDescription>
          </DialogHeader>

          {!runtimeReady ? (
            <div className="flex gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <div>
                <p className="font-medium">Runtime is not online</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  This MCP wants {connection.desiredState} and its runtime is{" "}
                  {connection.runtime.phase}. Connect it before rendering the prompt.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4">
            {visibleDefinitions.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-muted/20 p-5 text-center text-sm text-muted-foreground">
                This prompt accepts no arguments.
              </div>
            ) : (
              visibleDefinitions.map((definition, index) => (
                <PromptArgumentField
                  definition={definition}
                  disabled={mutation.isPending}
                  error={fieldErrors[String(index)]}
                  index={index}
                  key={`${definition.name}:${String(index)}`}
                />
              ))
            )}
            {definitions.length > visibleDefinitions.length ? (
              <p className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground">
                This prompt exceeds the bounded {String(MAX_PROMPT_ARGUMENTS)}-argument workbench
                limit and cannot be run here.
              </p>
            ) : null}
            {fieldErrors[PROMPT_ARGUMENT_ROOT_ERROR] ? (
              <p className="text-xs text-destructive" role="alert">
                {fieldErrors[PROMPT_ARGUMENT_ROOT_ERROR]}
              </p>
            ) : null}
          </div>

          {mutation.isError ? (
            <div
              aria-live="polite"
              className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-medium text-destructive">The prompt could not be rendered</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {getApiErrorMessage(mutation.error)}
              </p>
            </div>
          ) : null}

          {mutation.data ? <PromptGetResultView result={mutation.data} /> : null}

          <DialogFooter>
            <Button
              disabled={mutation.isPending}
              onClick={() => {
                mutation.reset();
                onDismiss();
              }}
              type="button"
              variant="ghost"
            >
              Close
            </Button>
            <Button
              disabled={!runtimeReady || definitions.length > MAX_PROMPT_ARGUMENTS}
              loading={mutation.isPending}
              loadingText="Rendering…"
              type="submit"
            >
              <Play />
              Render prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PromptArgumentField({
  definition,
  index,
  disabled,
  error,
}: {
  readonly definition: NonNullable<Prompt["arguments"]>[number];
  readonly index: number;
  readonly disabled: boolean;
  readonly error?: string;
}) {
  const required = definition.required === true;
  const [included, setIncluded] = useState(required);
  const inputId = `prompt-argument-${String(index)}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <fieldset className="grid min-w-0 gap-2 rounded-xl border p-3">
      <legend className="sr-only">{definition.name}</legend>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <Label className="min-w-0 truncate" htmlFor={inputId}>
          {definition.name}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </Label>
        {required ? (
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Required
          </span>
        ) : (
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <input
              checked={included}
              className="size-4 accent-[var(--primary)]"
              disabled={disabled}
              name={promptArgumentIncludedName(index)}
              onChange={(event) => setIncluded(event.target.checked)}
              type="checkbox"
              value="true"
            />
            Include
          </label>
        )}
      </div>
      <Textarea
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={error !== undefined}
        disabled={disabled || !included}
        id={inputId}
        maxLength={MAX_PROMPT_ARGUMENT_CHARACTERS}
        name={promptArgumentValueName(index)}
        required={required}
        spellCheck={false}
      />
      <p className="text-xs leading-relaxed text-muted-foreground" id={hintId}>
        {definition.description ?? "Text value passed exactly as entered."}
      </p>
      {error ? (
        <p className="text-xs text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
