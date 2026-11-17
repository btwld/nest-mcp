"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, ShieldAlert, TriangleAlert, Wrench } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { JsonCodeDetails } from "@/components/json-code-editor";
import { JsonSchemaArgumentForm } from "@/components/json-schema-argument-form";
import { ToolResultView } from "@/components/tool-result-view";
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
import { getApiErrorMessage, type Connection, type Tool } from "@/lib/control-plane-api";
import { controlPlaneKeys, toolCallMutationOptions } from "@/lib/control-plane-queries";
import { stringifyJsonDocument } from "@/lib/json-document";
import { parseJsonSchemaArguments, type ArgumentFieldErrors } from "@/lib/json-schema-arguments";

const ARGUMENT_FIELD_PREFIX = "tool-call-arguments";

export function ToolExecutionDialog({
  connection,
  tool,
  onDismiss,
}: {
  readonly connection: Connection;
  readonly tool: Tool;
  readonly onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<ArgumentFieldErrors>({});
  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);
  const destructive = tool.annotations?.destructiveHint === true;
  const taskOnly = tool.execution?.taskSupport === "required";
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";

  const mutation = useMutation({
    ...toolCallMutationOptions(connection.id),
    onSuccess: (result) => {
      if (result.isError === true) {
        toast.error("Tool reported an error", { description: tool.name });
      } else {
        toast.success("Tool completed", { description: tool.name });
      }
    },
    onError: (error) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      ]);
      toast.error("Tool call failed", { description: getApiErrorMessage(error) });
    },
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseJsonSchemaArguments(tool.inputSchema, new FormData(event.currentTarget), {
      prefix: ARGUMENT_FIELD_PREFIX,
    });
    if (!parsed.success) {
      setFieldErrors(parsed.errors);
      return;
    }

    setFieldErrors({});
    mutation.reset();
    try {
      await mutation.mutateAsync({ name: tool.name, arguments: parsed.data });
    } catch {
      // The mutation renders the typed API error and keeps the arguments available for correction.
    }
  }

  const runDisabled = taskOnly || !runtimeReady || (destructive && !acknowledgedRisk);

  return (
    <Dialog onOpenChange={(open) => (!open && !mutation.isPending ? onDismiss() : undefined)} open>
      <DialogContent className="max-w-4xl">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant="mono">
                <Wrench className="size-3" /> Tool
              </Badge>
              {tool.annotations?.readOnlyHint ? (
                <Badge variant="success">Advertised read only</Badge>
              ) : null}
              {tool.annotations?.openWorldHint ? <Badge variant="warning">Open world</Badge> : null}
              {destructive ? <Badge variant="destructive">Destructive</Badge> : null}
            </div>
            <DialogTitle className="[overflow-wrap:anywhere]">
              Run {tool.title ?? tool.name}
            </DialogTitle>
            <DialogDescription>
              Execute{" "}
              <span className="font-mono text-foreground [overflow-wrap:anywhere]">
                {tool.name}
              </span>{" "}
              on {connection.displayName}. Every run is explicit and is never retried automatically.
            </DialogDescription>
          </DialogHeader>

          {taskOnly ? (
            <CallWarning
              icon={<ShieldAlert />}
              text="This tool requires MCP task execution, but the reference control plane currently supports synchronous calls only."
              title="Task-only tool"
            />
          ) : null}

          {!runtimeReady ? (
            <CallWarning
              icon={<ShieldAlert />}
              text={`This MCP wants ${connection.desiredState} and its runtime is ${connection.runtime.phase}. Connect it before running a tool.`}
              title="Runtime is not online"
            />
          ) : null}

          {tool.annotations?.openWorldHint || destructive ? (
            <CallWarning
              icon={<TriangleAlert />}
              text="Tool annotations come from the upstream server and are advisory. Review the arguments and expected external effects before running."
              title="Review external effects"
            />
          ) : null}

          <div className="grid gap-4">
            <JsonSchemaArgumentForm
              disabled={mutation.isPending || taskOnly}
              errors={fieldErrors}
              prefix={ARGUMENT_FIELD_PREFIX}
              schema={tool.inputSchema}
            />

            <JsonCodeDetails
              ariaLabel="Advertised tool input schema JSON"
              className="rounded-xl bg-muted/15"
              code={stringifyJsonDocument(tool.inputSchema, "[Unable to serialize schema]")}
              maxHeight="14rem"
              summaryClassName="px-3"
            >
              Advertised input schema
            </JsonCodeDetails>
          </div>

          {destructive ? (
            <label
              aria-label="Acknowledge destructive tool risk"
              className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3"
              htmlFor="destructive-tool-confirmation"
            >
              <input
                checked={acknowledgedRisk}
                className="mt-0.5 size-4 accent-[var(--destructive)]"
                disabled={mutation.isPending}
                id="destructive-tool-confirmation"
                onChange={(event) => setAcknowledgedRisk(event.target.checked)}
                type="checkbox"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">I understand this tool may make changes</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  The upstream advertises this operation as destructive. This confirmation is not a
                  substitute for a production approval policy.
                </span>
              </span>
            </label>
          ) : null}

          {mutation.isError ? (
            <div
              aria-live="polite"
              className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-medium text-destructive">The call could not be completed</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {getApiErrorMessage(mutation.error)}
              </p>
            </div>
          ) : null}

          {mutation.data ? <ToolResultView result={mutation.data} /> : null}

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
              disabled={runDisabled}
              loading={mutation.isPending}
              loadingText="Running…"
              type="submit"
              variant={destructive ? "destructive" : "default"}
            >
              <Play />
              Run tool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CallWarning({
  icon,
  title,
  text,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly text: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
      <span className="mt-0.5 shrink-0 text-warning-foreground [&_svg]:size-4">{icon}</span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
