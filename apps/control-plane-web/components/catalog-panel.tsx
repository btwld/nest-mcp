"use client";

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  Clock3,
  FileStack,
  FileText,
  MessageSquareText,
  Play,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConnectionValidationSummary } from "@/components/connection-validation-summary";
import { ConnectionConformancePanel } from "@/components/connection-conformance-panel";
import { JsonCodeDetails } from "@/components/json-code-editor";
import { PromptGetDialog } from "@/components/prompt-get-dialog";
import { ResourceReadDialog } from "@/components/resource-read-dialog";
import { ToolExecutionDialog } from "@/components/tool-execution-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ControlPlaneApiError,
  controlPlaneApi,
  getApiErrorMessage,
  type Catalog,
  type Connection,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@/lib/control-plane-api";
import { controlPlaneKeys } from "@/lib/control-plane-queries";
import { stringifyJsonDocument } from "@/lib/json-document";

const utcDateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function CatalogPanel({ connection }: { readonly connection: Connection }) {
  const queryClient = useQueryClient();
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const toolCallPending =
    useIsMutating({ mutationKey: controlPlaneKeys.toolCall(connection.id) }) > 0;
  const resourceReadPending =
    useIsMutating({ mutationKey: controlPlaneKeys.resourceRead(connection.id) }) > 0;
  const promptGetPending =
    useIsMutating({ mutationKey: controlPlaneKeys.promptGet(connection.id) }) > 0;
  const capabilityOperationPending = toolCallPending || resourceReadPending || promptGetPending;
  const queryKey = controlPlaneKeys.catalog(connection.id, connection.runtimeGeneration);
  const catalogQuery = useQuery({
    enabled: !connection.deletionPending,
    queryKey,
    queryFn: ({ signal }) => controlPlaneApi.getCatalog(connection.id, signal),
  });
  const refreshMutation = useMutation({
    mutationFn: () => controlPlaneApi.refreshCatalog(connection.id),
    onSuccess: (catalog) => {
      queryClient.setQueryData(queryKey, catalog);
      toast.success("Catalog refreshed", {
        description: `${String(catalog.tools.length + catalog.resources.length + catalog.resourceTemplates.length + catalog.prompts.length)} capabilities discovered.`,
      });
    },
    onError: (error) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.connections }),
        queryClient.invalidateQueries({ queryKey: controlPlaneKeys.runtime }),
      ]);
      toast.error("Catalog refresh failed", { description: getApiErrorMessage(error) });
    },
  });

  if (connection.deletionPending) {
    return (
      <section aria-labelledby="catalog-heading" className="min-w-0">
        <h2 className="text-lg font-semibold" id="catalog-heading">
          {connection.displayName}
        </h2>
        <Card className="mt-4 grid min-h-64 place-items-center border-dashed bg-card/60 p-6 text-center">
          <div className="max-w-sm">
            <ShieldAlert className="mx-auto size-6 text-destructive" />
            <h3 className="mt-3 font-medium">MCP scheduled for deletion</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Its capabilities are no longer available. Runtime cleanup must finish before this MCP
              can be removed.
            </p>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section aria-labelledby="catalog-heading" className="min-w-0">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold" id="catalog-heading">
            {connection.displayName}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Discovered MCP capabilities</p>
        </div>
        <Button
          disabled={capabilityOperationPending}
          loading={refreshMutation.isPending}
          loadingText="Refreshing…"
          onClick={() => refreshMutation.mutate()}
          size="sm"
          variant="outline"
        >
          <RefreshCw />
          Refresh catalog
        </Button>
      </div>

      <ConnectionValidationSummary catalog={catalogQuery.data} connection={connection} />
      <ConnectionConformancePanel connection={connection} />

      {catalogQuery.isPending ? <CatalogLoading /> : null}
      {catalogQuery.isError ? (
        <CatalogError
          error={catalogQuery.error}
          onRefresh={() => refreshMutation.mutate()}
          onRetry={() => void catalogQuery.refetch()}
          refreshing={refreshMutation.isPending}
        />
      ) : null}
      {catalogQuery.data ? (
        <CatalogTabs
          catalog={catalogQuery.data}
          connection={connection}
          onGetPrompt={setSelectedPrompt}
          onReadResource={setSelectedResource}
          onRunTool={setSelectedTool}
          promptGetPending={promptGetPending}
          resourceReadPending={resourceReadPending}
          toolCallPending={toolCallPending}
        />
      ) : null}
      {selectedTool ? (
        <ToolExecutionDialog
          connection={connection}
          key={`${connection.id}:${String(connection.runtimeGeneration)}:${selectedTool.name}`}
          onDismiss={() => setSelectedTool(null)}
          tool={selectedTool}
        />
      ) : null}
      {selectedResource ? (
        <ResourceReadDialog
          connection={connection}
          key={`${connection.id}:${String(connection.runtimeGeneration)}:${selectedResource.uri}`}
          onDismiss={() => setSelectedResource(null)}
          resource={selectedResource}
        />
      ) : null}
      {selectedPrompt ? (
        <PromptGetDialog
          connection={connection}
          key={`${connection.id}:${String(connection.runtimeGeneration)}:${selectedPrompt.name}`}
          onDismiss={() => setSelectedPrompt(null)}
          prompt={selectedPrompt}
        />
      ) : null}
    </section>
  );
}

function CatalogLoading() {
  return (
    <Card className="grid min-h-72 place-items-center border-dashed bg-card/60">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading cached catalog…
      </div>
    </Card>
  );
}

function CatalogError({
  error,
  onRefresh,
  onRetry,
  refreshing,
}: {
  readonly error: Error;
  readonly onRefresh: () => void;
  readonly onRetry: () => void;
  readonly refreshing: boolean;
}) {
  const isMissing = error instanceof ControlPlaneApiError && error.code === "MCP_NOT_READY";
  return (
    <Card className="grid min-h-72 place-items-center border-dashed bg-card/60 p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
          <FileStack className="size-5" />
        </div>
        <h3 className="font-medium">
          {isMissing ? "No catalog snapshot yet" : "Catalog unavailable"}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {isMissing
            ? "Discover the MCP server to load its current capabilities."
            : getApiErrorMessage(error)}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {isMissing ? null : (
            <Button onClick={onRetry} size="sm" variant="ghost">
              Retry read
            </Button>
          )}
          <Button loading={refreshing} loadingText="Discovering…" onClick={onRefresh} size="sm">
            <RefreshCw />
            Discover now
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CatalogTabs({
  catalog,
  connection,
  toolCallPending,
  resourceReadPending,
  promptGetPending,
  onRunTool,
  onReadResource,
  onGetPrompt,
}: {
  readonly catalog: Catalog;
  readonly connection: Connection;
  readonly toolCallPending: boolean;
  readonly resourceReadPending: boolean;
  readonly promptGetPending: boolean;
  readonly onRunTool: (tool: Tool) => void;
  readonly onReadResource: (resource: Resource) => void;
  readonly onGetPrompt: (prompt: Prompt) => void;
}) {
  return (
    <Tabs defaultValue="tools">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
        <TabsList aria-label="Catalog sections">
          <TabsTrigger value="tools">
            Tools <Count value={catalog.tools.length} />
          </TabsTrigger>
          <TabsTrigger value="resources">
            Resources <Count value={catalog.resources.length} />
          </TabsTrigger>
          <TabsTrigger value="templates">
            Templates <Count value={catalog.resourceTemplates.length} />
          </TabsTrigger>
          <TabsTrigger value="prompts">
            Prompts <Count value={catalog.prompts.length} />
          </TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" />
          <time dateTime={catalog.discoveredAt}>
            {utcDateTime.format(new Date(catalog.discoveredAt))} UTC
          </time>
        </div>
      </div>
      <TabsContent value="tools">
        <CatalogGrid
          emptyDescription="This server did not advertise any tools."
          emptyTitle="No tools"
          items={catalog.tools}
          renderItem={(tool) => (
            <ToolItem
              connection={connection}
              key={tool.name}
              onRun={() => onRunTool(tool)}
              pending={toolCallPending}
              tool={tool}
            />
          )}
        />
      </TabsContent>
      <TabsContent value="resources">
        <CatalogGrid
          emptyDescription="This server did not advertise any concrete resources."
          emptyTitle="No resources"
          items={catalog.resources}
          renderItem={(resource) => (
            <ResourceItem
              connection={connection}
              key={resource.uri}
              onRead={() => onReadResource(resource)}
              pending={resourceReadPending}
              resource={resource}
            />
          )}
        />
      </TabsContent>
      <TabsContent value="templates">
        <CatalogGrid
          emptyDescription="This server did not advertise any resource URI templates."
          emptyTitle="No templates"
          items={catalog.resourceTemplates}
          renderItem={(template) => <TemplateItem key={template.uriTemplate} template={template} />}
        />
      </TabsContent>
      <TabsContent value="prompts">
        <CatalogGrid
          emptyDescription="This server did not advertise any prompt templates."
          emptyTitle="No prompts"
          items={catalog.prompts}
          renderItem={(prompt) => (
            <PromptItem
              connection={connection}
              key={prompt.name}
              onGet={() => onGetPrompt(prompt)}
              pending={promptGetPending}
              prompt={prompt}
            />
          )}
        />
      </TabsContent>
    </Tabs>
  );
}

function Count({ value }: { readonly value: number }) {
  return <span className="rounded bg-foreground/7 px-1 text-[10px] tabular-nums">{value}</span>;
}

function CatalogGrid<Item>({
  items,
  renderItem,
  emptyTitle,
  emptyDescription,
}: {
  readonly items: readonly Item[];
  readonly renderItem: (item: Item) => React.ReactNode;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}) {
  if (items.length === 0) {
    return (
      <div className="grid min-h-56 place-items-center rounded-xl border border-dashed bg-muted/20 p-6 text-center">
        <div>
          <h3 className="text-sm font-medium">{emptyTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{emptyDescription}</p>
        </div>
      </div>
    );
  }
  return <div className="grid gap-3 lg:grid-cols-2">{items.map(renderItem)}</div>;
}

function ToolItem({
  tool,
  connection,
  pending,
  onRun,
}: {
  readonly tool: Tool;
  readonly connection: Connection;
  readonly pending: boolean;
  readonly onRun: () => void;
}) {
  const taskOnly = tool.execution?.taskSupport === "required";
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const disabledReason = taskOnly
    ? "Task-only tools are not supported yet."
    : !runtimeReady
      ? "Connect this runtime before calling tools."
      : pending
        ? "Another tool call is running for this connection."
        : undefined;

  return (
    <CatalogItem
      description={tool.description}
      icon={<Wrench />}
      name={tool.title ?? tool.name}
      secondary={tool.title ? tool.name : undefined}
    >
      <div className="flex flex-wrap gap-1.5">
        {tool.annotations?.readOnlyHint ? <Badge variant="success">Read only</Badge> : null}
        {tool.annotations?.destructiveHint ? (
          <Badge variant="destructive">Destructive</Badge>
        ) : null}
        {tool.annotations?.idempotentHint ? <Badge variant="info">Idempotent</Badge> : null}
        {tool.annotations?.openWorldHint ? <Badge variant="warning">Open world</Badge> : null}
        {tool.execution?.taskSupport ? (
          <Badge variant="outline">Tasks: {tool.execution.taskSupport}</Badge>
        ) : null}
      </div>
      <SchemaDetails label="Input schema" schema={tool.inputSchema} />
      {tool.outputSchema ? (
        <SchemaDetails label="Output schema" schema={tool.outputSchema} />
      ) : null}
      <div className="mt-1 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          {disabledReason ?? "Arguments are checked against the advertised input schema."}
        </span>
        <Button disabled={disabledReason !== undefined} onClick={onRun} size="sm" type="button">
          <Play />
          Run tool
        </Button>
      </div>
    </CatalogItem>
  );
}

export function ResourceItem({
  resource,
  connection,
  pending,
  onRead,
}: {
  readonly resource: Resource;
  readonly connection: Connection;
  readonly pending: boolean;
  readonly onRead: () => void;
}) {
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const disabledReason = !runtimeReady
    ? "Connect this runtime before reading resources."
    : pending
      ? "Another resource read is running for this connection."
      : undefined;
  return (
    <CatalogItem
      description={resource.description}
      icon={<FileText />}
      name={resource.title ?? resource.name}
      secondary={resource.uri}
    >
      <div className="flex flex-wrap gap-1.5">
        {resource.mimeType ? <Badge variant="outline">{resource.mimeType}</Badge> : null}
        {resource.size !== undefined ? (
          <Badge variant="mono">{formatBytes(resource.size)}</Badge>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          {disabledReason ?? "Read this exact advertised URI with an explicit request."}
        </span>
        <Button disabled={disabledReason !== undefined} onClick={onRead} size="sm" type="button">
          <FileText />
          Read
        </Button>
      </div>
    </CatalogItem>
  );
}

function TemplateItem({ template }: { readonly template: ResourceTemplate }) {
  return (
    <CatalogItem
      description={template.description}
      icon={<Braces />}
      name={template.title ?? template.name}
      secondary={template.uriTemplate}
    >
      {template.mimeType ? <Badge variant="outline">{template.mimeType}</Badge> : null}
    </CatalogItem>
  );
}

export function PromptItem({
  prompt,
  connection,
  pending,
  onGet,
}: {
  readonly prompt: Prompt;
  readonly connection: Connection;
  readonly pending: boolean;
  readonly onGet: () => void;
}) {
  const runtimeReady =
    connection.desiredState === "online" && connection.runtime.phase === "online";
  const disabledReason = !runtimeReady
    ? "Connect this runtime before rendering prompts."
    : pending
      ? "Another prompt request is running for this connection."
      : undefined;
  const promptArguments = prompt.arguments ?? [];
  const visibleArguments = promptArguments.slice(0, 20);
  return (
    <CatalogItem
      description={prompt.description}
      icon={<MessageSquareText />}
      name={prompt.title ?? prompt.name}
      secondary={prompt.title ? prompt.name : undefined}
    >
      {promptArguments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {visibleArguments.map((argument, index) => (
            <Badge
              key={`${argument.name}:${String(index)}`}
              variant={argument.required ? "info" : "outline"}
            >
              {argument.name}
              {argument.required ? " *" : ""}
            </Badge>
          ))}
          {promptArguments.length > visibleArguments.length ? (
            <Badge variant="outline">
              +{String(promptArguments.length - visibleArguments.length)} more
            </Badge>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">No arguments</span>
      )}
      <div className="mt-1 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          {disabledReason ?? "Provide text arguments and inspect the rendered MCP messages."}
        </span>
        <Button disabled={disabledReason !== undefined} onClick={onGet} size="sm" type="button">
          <Play />
          Render
        </Button>
      </div>
    </CatalogItem>
  );
}

function CatalogItem({
  icon,
  name,
  secondary,
  description,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly secondary?: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0 bg-card/75 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-4">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{name}</h3>
          {secondary ? (
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
              title={secondary}
            >
              {secondary}
            </p>
          ) : null}
        </div>
      </div>
      {description ? (
        <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-3 grid gap-2">{children}</div>
    </Card>
  );
}

function SchemaDetails({ label, schema }: { readonly label: string; readonly schema: unknown }) {
  return (
    <JsonCodeDetails
      ariaLabel={`${label} JSON`}
      code={stringifyJsonDocument(schema, "[Unable to serialize schema]")}
      maxHeight="13rem"
    >
      {label}
    </JsonCodeDetails>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
