import { KeyRound, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  oauthAuthorizationPath,
  type Connection,
  type ConnectionAuthentication,
  type OAuthAuthenticationStatus,
} from "@/lib/control-plane-api";

const statusPresentation: Record<
  OAuthAuthenticationStatus,
  {
    readonly badge: "success" | "info" | "warning" | "destructive";
    readonly label: string;
    readonly message: string;
  }
> = {
  "authorization-required": {
    badge: "warning",
    label: "authorization required",
    message: "Authorize this MCP before connecting it.",
  },
  authorizing: {
    badge: "info",
    label: "authorizing",
    message: "Browser authorization is in progress.",
  },
  authorized: {
    badge: "success",
    label: "authorized",
    message: "This API process can authenticate to the MCP.",
  },
  "reauthorization-required": {
    badge: "warning",
    label: "reauthorization required",
    message: "Renew browser authorization before reconnecting.",
  },
  failed: {
    badge: "destructive",
    label: "failed",
    message: "OAuth authorization could not be completed.",
  },
};

export function canConnectWithAuthentication(authentication: ConnectionAuthentication): boolean {
  return authentication.kind === "none" || authentication.status === "authorized";
}

export function ConnectionAuthenticationPanel({
  connection,
  disabled,
}: {
  readonly connection: Connection;
  readonly disabled: boolean;
}) {
  const authentication = connection.authentication;
  if (authentication.kind === "none") return null;

  const presentation = statusPresentation[authentication.status];
  const action =
    authentication.status === "authorization-required"
      ? "Authorize"
      : authentication.status === "authorizing"
        ? "Restart authorization"
        : "Reauthorize";
  const scopes = authentication.scopes ?? [];
  const visibleScopes = scopes.slice(0, 2);

  return (
    <div className="mt-3 rounded-lg border border-info/20 bg-info/5 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-4 shrink-0 text-info" />
          <Badge variant={presentation.badge}>OAuth · {presentation.label}</Badge>
        </div>
        <form action={oauthAuthorizationPath(connection.id, connection.revision)} method="post">
          <Button
            aria-label={`${action} ${connection.displayName} with OAuth`}
            disabled={disabled}
            size="sm"
            type="submit"
            variant={authentication.status === "authorized" ? "outline" : "default"}
          >
            <RotateCcw />
            {action}
          </Button>
        </form>
      </div>
      <p aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {presentation.message}
        {authentication.authorizationServerHost
          ? ` Authorization server: ${authentication.authorizationServerHost}.`
          : ""}
      </p>
      {visibleScopes.length > 0 ? (
        <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">
          Scopes: {visibleScopes.join(", ")}
          {scopes.length > visibleScopes.length
            ? `, +${String(scopes.length - visibleScopes.length)} more`
            : ""}
        </p>
      ) : null}
      {authentication.errorCode ? (
        <p className="mt-1 font-mono text-[10px] text-destructive">{authentication.errorCode}</p>
      ) : null}
    </div>
  );
}
