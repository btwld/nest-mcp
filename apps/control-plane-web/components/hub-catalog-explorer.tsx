"use client";

import { ArrowRight, Clock3, Search } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HubCatalog } from "@/lib/control-plane-api";

const utcDateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

type HubCatalogSection = "tools" | "resources" | "resourceTemplates" | "prompts";

interface HubCatalogEntry {
  readonly namespace: string;
  readonly sourceName: string;
  readonly projectedName: string;
}

const sectionLabels: Record<HubCatalogSection, string> = {
  tools: "Tools",
  resources: "Resources",
  resourceTemplates: "Templates",
  prompts: "Prompts",
};

export function HubCatalogExplorer({ catalog }: { readonly catalog: HubCatalog }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("en-US");
  const filteredCatalog = useMemo(
    () => ({
      tools: catalog.tools.filter((entry) => matchesQuery(entry, normalizedQuery)),
      resources: catalog.resources.filter((entry) =>
        matchesQuery(entry, normalizedQuery, entry.projectedUri),
      ),
      resourceTemplates: catalog.resourceTemplates.filter((entry) =>
        matchesQuery(entry, normalizedQuery, entry.projectedUriTemplate),
      ),
      prompts: catalog.prompts.filter((entry) => matchesQuery(entry, normalizedQuery)),
    }),
    [catalog, normalizedQuery],
  );
  const totalCount = catalogTotal(catalog);
  const filteredCount = catalogTotal(filteredCatalog);

  return (
    <section aria-labelledby="hub-catalog-heading" className="min-w-0">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold" id="hub-catalog-heading">
            Projected catalog
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Trace each upstream capability to the identifier published by the Hub.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="mono">Revision {catalog.revision}</Badge>
          <span className="flex items-center gap-1.5">
            <Clock3 aria-hidden="true" className="size-3.5" />
            <span>Published</span>
            <time dateTime={catalog.publishedAt}>
              {utcDateTime.format(new Date(catalog.publishedAt))} UTC
            </time>
          </span>
        </div>
      </div>

      <Card className="bg-card/75 p-4 shadow-sm">
        <div className="relative max-w-xl">
          <label className="sr-only" htmlFor={searchId}>
            Search projected catalog
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-9"
            id={searchId}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search namespace, source, projected name, or URI"
            type="search"
            value={query}
          />
        </div>
        <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
          {normalizedQuery.length > 0
            ? `${String(filteredCount)} of ${String(totalCount)} projected capabilities match.`
            : `${String(totalCount)} projected capabilities.`}
        </p>

        <Tabs className="mt-4" defaultValue={firstAvailableSection(catalog)}>
          <TabsList aria-label="Projected catalog sections">
            <CatalogTab
              filteredCount={filteredCatalog.tools.length}
              label={sectionLabels.tools}
              totalCount={catalog.tools.length}
              value="tools"
            />
            <CatalogTab
              filteredCount={filteredCatalog.resources.length}
              label={sectionLabels.resources}
              totalCount={catalog.resources.length}
              value="resources"
            />
            <CatalogTab
              filteredCount={filteredCatalog.resourceTemplates.length}
              label={sectionLabels.resourceTemplates}
              totalCount={catalog.resourceTemplates.length}
              value="resourceTemplates"
            />
            <CatalogTab
              filteredCount={filteredCatalog.prompts.length}
              label={sectionLabels.prompts}
              totalCount={catalog.prompts.length}
              value="prompts"
            />
          </TabsList>

          <TabsContent value="tools">
            <MappingList
              emptyDescription="No projected tools match the current search."
              entries={filteredCatalog.tools}
              kind="tool"
            />
          </TabsContent>
          <TabsContent value="resources">
            <MappingList
              emptyDescription="No projected resources match the current search."
              entries={filteredCatalog.resources}
              kind="resource"
            />
          </TabsContent>
          <TabsContent value="resourceTemplates">
            <MappingList
              emptyDescription="No projected resource templates match the current search."
              entries={filteredCatalog.resourceTemplates}
              kind="template"
            />
          </TabsContent>
          <TabsContent value="prompts">
            <MappingList
              emptyDescription="No projected prompts match the current search."
              entries={filteredCatalog.prompts}
              kind="prompt"
            />
          </TabsContent>
        </Tabs>
      </Card>
    </section>
  );
}

function CatalogTab({
  value,
  label,
  totalCount,
  filteredCount,
}: {
  readonly value: HubCatalogSection;
  readonly label: string;
  readonly totalCount: number;
  readonly filteredCount: number;
}) {
  return (
    <TabsTrigger value={value}>
      {label}
      <span className="rounded bg-foreground/7 px-1 text-[10px] tabular-nums">
        {filteredCount === totalCount
          ? totalCount
          : `${String(filteredCount)}/${String(totalCount)}`}
      </span>
    </TabsTrigger>
  );
}

type MappingKind = "tool" | "resource" | "template" | "prompt";

type MappingEntry = HubCatalogEntry & {
  readonly projectedUri?: string;
  readonly projectedUriTemplate?: string;
};

function MappingList({
  entries,
  kind,
  emptyDescription,
}: {
  readonly entries: readonly MappingEntry[];
  readonly kind: MappingKind;
  readonly emptyDescription: string;
}) {
  if (entries.length === 0) {
    return (
      <div className="grid min-h-44 place-items-center rounded-xl border border-dashed bg-muted/20 p-6 text-center">
        <div>
          <h3 className="text-sm font-medium">No mappings</h3>
          <p className="mt-1 text-xs text-muted-foreground">{emptyDescription}</p>
        </div>
      </div>
    );
  }

  return (
    <ol className="grid gap-3">
      {entries.map((entry) => (
        <MappingRow
          entry={entry}
          key={`${entry.namespace}:${entry.sourceName}:${entry.projectedName}`}
          kind={kind}
        />
      ))}
    </ol>
  );
}

function MappingRow({ entry, kind }: { readonly entry: MappingEntry; readonly kind: MappingKind }) {
  const projectedUri = entry.projectedUri ?? entry.projectedUriTemplate;
  const projectedUriLabel = kind === "template" ? "Projected URI template" : "Projected URI";

  return (
    <li className="rounded-xl border bg-background/55 p-3">
      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.35fr)]">
        <Identifier label="Source identifier" value={entry.sourceName}>
          <Badge variant="outline">{entry.namespace}</Badge>
        </Identifier>
        <ArrowRight
          aria-label="is projected as"
          className="size-4 rotate-90 text-muted-foreground md:rotate-0"
          role="img"
        />
        <Identifier label="Projected name" value={entry.projectedName} />
      </div>
      {projectedUri === undefined ? null : (
        <div className="mt-3 border-t pt-3">
          <Identifier label={projectedUriLabel} value={projectedUri} />
        </div>
      )}
    </li>
  );
}

function Identifier({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {children}
      </div>
      <code className="block break-all text-xs font-medium">{value}</code>
    </div>
  );
}

function matchesQuery(
  entry: HubCatalogEntry,
  normalizedQuery: string,
  projectedUri?: string,
): boolean {
  if (normalizedQuery.length === 0) return true;
  return [entry.namespace, entry.sourceName, entry.projectedName, projectedUri].some((value) =>
    value?.toLocaleLowerCase("en-US").includes(normalizedQuery),
  );
}

function catalogTotal(
  catalog: Pick<HubCatalog, "tools" | "resources" | "resourceTemplates" | "prompts">,
): number {
  return (
    catalog.tools.length +
    catalog.resources.length +
    catalog.resourceTemplates.length +
    catalog.prompts.length
  );
}

function firstAvailableSection(catalog: HubCatalog): HubCatalogSection {
  if (catalog.tools.length > 0) return "tools";
  if (catalog.resources.length > 0) return "resources";
  if (catalog.resourceTemplates.length > 0) return "resourceTemplates";
  if (catalog.prompts.length > 0) return "prompts";
  return "tools";
}
