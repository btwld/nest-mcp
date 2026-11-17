"use client";

import { useState, type FormEvent } from "react";
import { PlugZap, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  connectionDraftSchema,
  connectionUpdateSchema,
  type Connection,
  type ConnectionAuthenticationInput,
  type ConnectionDraft,
  type ConnectionUpdate,
} from "@/lib/control-plane-api";

interface FieldErrors {
  readonly displayName?: string;
  readonly endpoint?: string;
}

function parseDraft(
  displayName: string,
  endpoint: string,
  authentication: ConnectionAuthenticationInput,
):
  | { readonly success: true; readonly data: ConnectionDraft }
  | { readonly success: false; readonly errors: FieldErrors } {
  const parsed = connectionDraftSchema.safeParse({ displayName, endpoint, authentication });
  if (parsed.success) return parsed;
  const fields = parsed.error.flatten().fieldErrors;
  return {
    success: false,
    errors: {
      displayName: fields.displayName?.[0],
      endpoint: fields.endpoint?.[0],
    },
  };
}

function parseUpdate(
  displayName: string,
  endpoint: string,
):
  | { readonly success: true; readonly data: ConnectionUpdate }
  | { readonly success: false; readonly errors: FieldErrors } {
  const parsed = connectionUpdateSchema.safeParse({
    displayName,
    ...(endpoint.trim().length === 0 ? {} : { endpoint }),
  });
  if (parsed.success) return parsed;
  const fields = parsed.error.flatten().fieldErrors;
  return {
    success: false,
    errors: {
      displayName: fields.displayName?.[0],
      endpoint: fields.endpoint?.[0],
    },
  };
}

interface CreateConnectionDialogProps {
  readonly pending: boolean;
  readonly onDismiss: () => void;
  readonly onSubmit: (draft: ConnectionDraft, connectNow: boolean) => Promise<void>;
}

export function CreateConnectionDialog({
  pending,
  onDismiss,
  onSubmit,
}: CreateConnectionDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authenticationKind, setAuthenticationKind] =
    useState<ConnectionAuthenticationInput["kind"]>("none");
  const [connectNow, setConnectNow] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseDraft(displayName, endpoint, { kind: authenticationKind });
    if (!parsed.success) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    try {
      await onSubmit(parsed.data, connectNow);
    } catch {
      // The mutation owns error presentation and leaves this dialog open for correction.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (!open && !pending ? onDismiss() : undefined)} open>
      <DialogContent>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add MCP server</DialogTitle>
            <DialogDescription>
              Register an admitted HTTP endpoint. OAuth servers are authorized in the browser;
              secrets and custom headers are never entered here.
            </DialogDescription>
          </DialogHeader>
          <ConnectionFields
            displayName={displayName}
            endpoint={endpoint}
            errors={errors}
            onDisplayNameChange={setDisplayName}
            onEndpointChange={setEndpoint}
          />
          <AuthenticationFields
            kind={authenticationKind}
            onChange={(kind) => {
              setAuthenticationKind(kind);
              if (kind === "oauth") setConnectNow(false);
            }}
          />
          <div className="flex items-start gap-3 rounded-xl border bg-muted/35 p-3">
            <input
              checked={connectNow}
              className="mt-0.5 size-4 accent-[var(--primary)]"
              disabled={authenticationKind === "oauth"}
              id="connect-after-creation"
              onChange={(event) => setConnectNow(event.target.checked)}
              type="checkbox"
            />
            <label className="grid cursor-pointer gap-0.5" htmlFor="connect-after-creation">
              <span className="text-sm font-medium">Connect after creation</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {authenticationKind === "oauth"
                  ? "OAuth servers are added offline. Authorize from the MCP card, then connect."
                  : "Leave off to save it in the offline desired state."}
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button disabled={pending} onClick={onDismiss} type="button" variant="ghost">
              Cancel
            </Button>
            <Button loading={pending} loadingText="Adding…" type="submit">
              <PlugZap />
              Add MCP
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthenticationFields({
  kind,
  onChange,
}: {
  readonly kind: ConnectionAuthenticationInput["kind"];
  readonly onChange: (kind: ConnectionAuthenticationInput["kind"]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">Authentication</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label
          aria-label="No authentication"
          className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 has-checked:border-info/55 has-checked:bg-info/5"
          htmlFor="connection-authentication-none"
        >
          <input
            checked={kind === "none"}
            className="mt-0.5 size-4 accent-[var(--primary)]"
            id="connection-authentication-none"
            name="connection-authentication"
            onChange={() => onChange("none")}
            type="radio"
            value="none"
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">No authentication</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Connect directly without an authorization flow.
            </span>
          </span>
        </label>
        <label
          aria-label="OAuth 2.1"
          className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 has-checked:border-info/55 has-checked:bg-info/5"
          htmlFor="connection-authentication-oauth"
        >
          <input
            aria-describedby="oauth-process-memory-note"
            checked={kind === "oauth"}
            className="mt-0.5 size-4 accent-[var(--primary)]"
            id="connection-authentication-oauth"
            name="connection-authentication"
            onChange={() => onChange("oauth")}
            type="radio"
            value="oauth"
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">OAuth 2.1</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Authorize interactively with the upstream MCP server.
            </span>
          </span>
        </label>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground" id="oauth-process-memory-note">
        OAuth authorization state lives only in the API process and is cleared when it restarts.
      </p>
    </fieldset>
  );
}

interface EditConnectionDialogProps {
  readonly connection: Connection;
  readonly pending: boolean;
  readonly onDismiss: () => void;
  readonly onSubmit: (draft: ConnectionUpdate) => Promise<void>;
}

export function EditConnectionDialog({
  connection,
  pending,
  onDismiss,
  onSubmit,
}: EditConnectionDialogProps) {
  const [displayName, setDisplayName] = useState(connection.displayName);
  const [endpoint, setEndpoint] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseUpdate(displayName, endpoint);
    if (!parsed.success) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    try {
      await onSubmit(parsed.data);
    } catch {
      // The mutation owns error presentation and leaves this dialog open for correction.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (!open && !pending ? onDismiss() : undefined)} open>
      <DialogContent>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit MCP</DialogTitle>
            <DialogDescription>
              Leave the endpoint blank to keep the current address. Entering a new URL restarts the
              active MCP session.
            </DialogDescription>
          </DialogHeader>
          <ConnectionFields
            displayName={displayName}
            endpoint={endpoint}
            endpointHint={`Leave blank to keep ${connection.transport.host}.`}
            endpointRequired={false}
            errors={errors}
            onDisplayNameChange={setDisplayName}
            onEndpointChange={setEndpoint}
          />
          <DialogFooter>
            <Button disabled={pending} onClick={onDismiss} type="button" variant="ghost">
              Cancel
            </Button>
            <Button loading={pending} loadingText="Saving…" type="submit">
              <Save />
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionFields({
  displayName,
  endpoint,
  endpointHint,
  endpointRequired = true,
  errors,
  onDisplayNameChange,
  onEndpointChange,
}: {
  readonly displayName: string;
  readonly endpoint: string;
  readonly endpointHint?: string;
  readonly endpointRequired?: boolean;
  readonly errors: FieldErrors;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onEndpointChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="connection-display-name">Display name</Label>
        <Input
          aria-describedby={errors.displayName ? "display-name-error" : undefined}
          aria-invalid={errors.displayName !== undefined}
          autoComplete="off"
          id="connection-display-name"
          maxLength={120}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="Documentation server"
          required
          value={displayName}
        />
        {errors.displayName ? (
          <p className="text-xs text-destructive" id="display-name-error">
            {errors.displayName}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="connection-endpoint">HTTP endpoint</Label>
        <Input
          aria-describedby={errors.endpoint ? "endpoint-error" : "endpoint-hint"}
          aria-invalid={errors.endpoint !== undefined}
          autoCapitalize="none"
          autoComplete="off"
          id="connection-endpoint"
          inputMode="url"
          onChange={(event) => onEndpointChange(event.target.value)}
          placeholder="http://127.0.0.1:3200/mcp"
          required={endpointRequired}
          spellCheck={false}
          type="url"
          value={endpoint}
        />
        {errors.endpoint ? (
          <p className="text-xs text-destructive" id="endpoint-error">
            {errors.endpoint}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" id="endpoint-hint">
            {endpointHint ??
              "Admission policy is enforced by the API before the endpoint is saved."}
          </p>
        )}
      </div>
    </div>
  );
}

export function DeleteConnectionDialog({
  connection,
  pending,
  onDismiss,
  onConfirm,
}: {
  readonly connection: Connection;
  readonly pending: boolean;
  readonly onDismiss: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  async function confirmDelete() {
    try {
      await onConfirm();
    } catch {
      // The mutation owns error presentation and leaves this dialog open for retry.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (!open && !pending ? onDismiss() : undefined)} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {connection.displayName}?</DialogTitle>
          <DialogDescription>
            The active MCP session will be stopped before this server is removed. This cannot be
            undone from the manager.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 font-mono text-xs text-destructive">
          {connection.transport.host}
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={onDismiss} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            loading={pending}
            loadingText="Deleting…"
            onClick={() => void confirmDelete()}
            type="button"
            variant="destructive"
          >
            <Trash2 />
            Delete MCP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
