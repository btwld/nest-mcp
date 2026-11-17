import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Catalog, Connection } from "@/lib/control-plane-api";
import { MAX_PROMPT_ARGUMENTS } from "@/lib/prompt-arguments";

const supportedToolSchemaDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);

export type ValidationCheckStatus = "pass" | "warn" | "unknown";

export interface ConnectionValidationCheck {
  readonly id: "authorization" | "runtime" | "protocol" | "catalog" | "workbench" | "schemas";
  readonly label: string;
  readonly status: ValidationCheckStatus;
  readonly detail: string;
}

export function connectionValidationChecks(
  connection: Connection,
  catalog: Catalog | undefined,
): readonly ConnectionValidationCheck[] {
  return [
    authorizationCheck(connection),
    runtimeCheck(connection),
    protocolCheck(connection),
    catalogCheck(connection, catalog),
    workbenchCheck(catalog),
    toolSchemaCheck(catalog),
  ];
}

export function ConnectionValidationSummary({
  connection,
  catalog,
}: {
  readonly connection: Connection;
  readonly catalog: Catalog | undefined;
}) {
  const checks = connectionValidationChecks(connection, catalog);
  return (
    <section
      aria-labelledby="validation-summary-heading"
      className="mb-5 rounded-xl border bg-card/55 p-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium" id="validation-summary-heading">
            Current observations
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Live hints from the current runtime and loaded catalog; repeatable checks are below.
          </p>
        </div>
        <div className="flex gap-1.5 text-[10px] text-muted-foreground">
          <span>{checks.filter((check) => check.status === "pass").length} pass</span>
          <span>·</span>
          <span>{checks.filter((check) => check.status === "warn").length} warn</span>
          <span>·</span>
          <span>{checks.filter((check) => check.status === "unknown").length} unknown</span>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <ValidationCheck check={check} key={check.id} />
        ))}
      </div>
    </section>
  );
}

function ValidationCheck({ check }: { readonly check: ConnectionValidationCheck }) {
  const Icon =
    check.status === "pass" ? CircleCheck : check.status === "warn" ? TriangleAlert : CircleHelp;
  return (
    <article className="min-w-0 rounded-lg border bg-background/65 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{check.label}</span>
        <Badge
          variant={
            check.status === "pass" ? "success" : check.status === "warn" ? "warning" : "outline"
          }
        >
          <Icon className="size-3" />
          {check.status}
        </Badge>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{check.detail}</p>
    </article>
  );
}

function authorizationCheck(connection: Connection): ConnectionValidationCheck {
  if (connection.authentication.kind === "none") {
    if (connection.runtime.phase !== "online") {
      return {
        id: "authorization",
        label: "Authorization",
        status: "unknown",
        detail:
          "No upstream authentication is configured; an unauthenticated connection is not currently observed.",
      };
    }
    return {
      id: "authorization",
      label: "Authorization",
      status: "pass",
      detail: "The runtime connected with no upstream authentication configured.",
    };
  }
  if (connection.authentication.status === "authorized") {
    return {
      id: "authorization",
      label: "Authorization",
      status: "pass",
      detail: "OAuth credentials are authorized.",
    };
  }
  if (connection.authentication.status === "authorizing") {
    return {
      id: "authorization",
      label: "Authorization",
      status: "unknown",
      detail: "OAuth authorization is still in progress.",
    };
  }
  return {
    id: "authorization",
    label: "Authorization",
    status: "warn",
    detail: `OAuth is ${connection.authentication.status.replaceAll("-", " ")}.`,
  };
}

function runtimeCheck(connection: Connection): ConnectionValidationCheck {
  if (connection.desiredState === "online" && connection.runtime.phase === "online") {
    return {
      id: "runtime",
      label: "Runtime online",
      status: "pass",
      detail: `Generation ${String(connection.runtimeGeneration)} is online.`,
    };
  }
  if (connection.runtime.phase === "queued" || connection.runtime.phase === "connecting") {
    return {
      id: "runtime",
      label: "Runtime online",
      status: "unknown",
      detail: `Runtime is ${connection.runtime.phase}; online readiness is not observed yet.`,
    };
  }
  return {
    id: "runtime",
    label: "Runtime online",
    status: "warn",
    detail: `Desired state is ${connection.desiredState}; runtime is ${connection.runtime.phase}.`,
  };
}

function protocolCheck(connection: Connection): ConnectionValidationCheck {
  const { protocolEra, protocolVersion } = connection.runtime;
  if (protocolEra !== undefined && protocolVersion !== undefined) {
    return {
      id: "protocol",
      label: "Protocol observed",
      status: "pass",
      detail: `${protocolVersion} · ${protocolEra}`,
    };
  }
  return {
    id: "protocol",
    label: "Protocol observed",
    status: "unknown",
    detail: "No complete negotiated protocol observation is available.",
  };
}

function catalogCheck(
  connection: Connection,
  catalog: Catalog | undefined,
): ConnectionValidationCheck {
  if (catalog === undefined) {
    return {
      id: "catalog",
      label: "Catalog discovered",
      status: "unknown",
      detail: "No catalog snapshot is loaded in this view.",
    };
  }
  if (catalog.runtimeGeneration !== connection.runtimeGeneration) {
    return {
      id: "catalog",
      label: "Catalog discovered",
      status: "warn",
      detail: `Snapshot generation ${String(catalog.runtimeGeneration)} does not match runtime generation ${String(connection.runtimeGeneration)}.`,
    };
  }
  return {
    id: "catalog",
    label: "Catalog discovered",
    status: "pass",
    detail: `Current generation discovered at ${catalog.discoveredAt}.`,
  };
}

function workbenchCheck(catalog: Catalog | undefined): ConnectionValidationCheck {
  if (catalog === undefined) {
    return {
      id: "workbench",
      label: "Workbench coverage",
      status: "unknown",
      detail: "Load a catalog to map capability and schema coverage.",
    };
  }
  const total =
    catalog.tools.length +
    catalog.resources.length +
    catalog.resourceTemplates.length +
    catalog.prompts.length;
  if (total === 0) {
    return {
      id: "workbench",
      label: "Workbench coverage",
      status: "warn",
      detail: "The catalog advertises no capabilities to validate.",
    };
  }
  const supportedTools = catalog.tools.filter(
    (tool) => tool.execution?.taskSupport !== "required" && tool.name.length <= 200,
  ).length;
  const supportedResources = catalog.resources.filter(
    (resource) => resource.uri.length <= 4_096,
  ).length;
  const supportedPrompts = catalog.prompts.filter((prompt) => {
    if (prompt.name.length > 200) return false;
    const definitions = prompt.arguments ?? [];
    if (definitions.length > MAX_PROMPT_ARGUMENTS) return false;
    const names = new Set(definitions.map((definition) => definition.name));
    return (
      names.size === definitions.length &&
      definitions.every((definition) => definition.name.length <= 200)
    );
  }).length;
  const supported = supportedTools + supportedResources + supportedPrompts;
  const unsupported = total - supported;
  return {
    id: "workbench",
    label: "Workbench coverage",
    status: unsupported === 0 ? "pass" : "warn",
    detail:
      unsupported === 0
        ? `${String(supported)} of ${String(total)} capabilities have direct forms or schema-aware inputs.`
        : `${String(supported)} of ${String(total)} capabilities are runnable here; ${String(unsupported)} needs task, URI-template, or larger-input support.`,
  };
}

function toolSchemaCheck(catalog: Catalog | undefined): ConnectionValidationCheck {
  if (catalog === undefined) {
    return {
      id: "schemas",
      label: "Tool schemas",
      status: "unknown",
      detail: "Load a catalog before evaluating advertised tool schemas.",
    };
  }
  if (catalog.tools.length === 0) {
    return {
      id: "schemas",
      label: "Tool schemas",
      status: "pass",
      detail: "No tool input schemas require compilation.",
    };
  }
  const unsupportedDrafts = catalog.tools.filter((tool) => {
    const declaredDraft = tool.inputSchema.$schema;
    return (
      typeof declaredDraft === "string" &&
      !supportedToolSchemaDialects.has(declaredDraft.replace(/#$/u, ""))
    );
  });
  if (unsupportedDrafts.length > 0) {
    return {
      id: "schemas",
      label: "Tool schemas",
      status: "warn",
      detail: `${String(unsupportedDrafts.length)} tool schema${unsupportedDrafts.length === 1 ? " declares" : "s declare"} an unsupported JSON Schema draft.`,
    };
  }
  return {
    id: "schemas",
    label: "Tool schemas",
    status: "unknown",
    detail: "Exact Draft 2020-12 compilation is enforced server-side immediately before execution.",
  };
}
