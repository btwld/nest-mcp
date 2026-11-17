"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { ResourceReadResultView } from "@/components/capability-result-view";
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
import { getApiErrorMessage, type Connection, type Resource } from "@/lib/control-plane-api";
import { controlPlaneKeys, resourceReadMutationOptions } from "@/lib/control-plane-queries";

export function ResourceReadDialog({
  connection,
  resource,
  onDismiss,
}: {
  readonly connection: Connection;
  readonly resource: Resource;
  readonly onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const mutation = useMutation({
    ...resourceReadMutationOptions(connection.id),
    onSuccess: () => {
      toast.success("Resource read completed", { description: resource.title ?? resource.name });
    },
    onError: (error) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      ]);
      toast.error("Resource read failed", { description: getApiErrorMessage(error) });
    },
  });

  return (
    <Dialog onOpenChange={(open) => (!open && !mutation.isPending ? onDismiss() : undefined)} open>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant="mono">
              <BookOpenText className="size-3" /> Resource
            </Badge>
            {resource.mimeType ? <Badge variant="outline">{resource.mimeType}</Badge> : null}
          </div>
          <DialogTitle>Read {resource.title ?? resource.name}</DialogTitle>
          <DialogDescription>
            Read this concrete resource from {connection.displayName}. The request is explicit and
            is never retried automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/15 p-3">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Resource URI
          </p>
          <code className="mt-1 block break-all text-xs">{resource.uri}</code>
        </div>

        {!runtimeReady ? (
          <div className="flex gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <div>
              <p className="font-medium">Runtime is not online</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                This MCP wants {connection.desiredState} and its runtime is{" "}
                {connection.runtime.phase}. Connect it before reading the resource.
              </p>
            </div>
          </div>
        ) : null}

        {mutation.isError ? (
          <div
            aria-live="polite"
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium text-destructive">The resource could not be read</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {getApiErrorMessage(mutation.error)}
            </p>
          </div>
        ) : null}

        {mutation.data ? <ResourceReadResultView result={mutation.data} /> : null}

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
            disabled={!runtimeReady}
            loading={mutation.isPending}
            loadingText="Reading…"
            onClick={() => mutation.mutate({ uri: resource.uri })}
            type="button"
          >
            <BookOpenText />
            Read resource
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
