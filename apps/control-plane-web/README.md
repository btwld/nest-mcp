# MCP Manager Web

Private Vinext console for managing MCP servers through the Nest MCP control-plane API. The primary
surface covers server lifecycle, runtime health, discovered tools, resources, templates, prompts,
and inclusion in one unified MCP endpoint. The capability workbench can run tools, read concrete
resources, and render prompts through explicit, non-retried requests. Its tool console parses a safe
subset of advertised JSON Schema and falls back to raw JSON for ambiguous schemas. Result previews
are bounded and never interpret upstream HTML, URLs, or binary payloads. The Hub catalog explorer
shows how upstream names and URIs are projected through the unified endpoint. A generation-scoped
conformance panel can run the server-owned passive discovery plan and inspect its bounded report
history. The app does not collect MCP tokens, client secrets, custom authorization headers, or PKCE
material.

## Local development

The API defaults to `127.0.0.1:3400` and the web app to `127.0.0.1:5173`.

```bash
pnpm --filter @nest-mcp/control-plane-api dev
pnpm --filter @nest-mcp/control-plane-web dev
```

Copy `.env.example` to `.env.local` only when the API uses another local address:

```dotenv
CONTROL_PLANE_API_URL=http://127.0.0.1:3400
NEXT_PUBLIC_CONTROL_PLANE_REQUEST_TIMEOUT_MS=45000
```

The browser always calls same-origin `/api`. Vite proxies those requests to the configured API and
strips the `/api` prefix, so `/api/v1/mcp/runtime` reaches `/v1/mcp/runtime` upstream.

If API lifecycle timeouts are raised, also raise `NEXT_PUBLIC_CONTROL_PLANE_REQUEST_TIMEOUT_MS` so
it remains above the combined operation drain, runtime shutdown, and replacement connection
budget. This avoids reporting an ambiguous browser timeout while a revisioned mutation is still
settling on the API.

Useful app-local checks:

```bash
pnpm --filter @nest-mcp/control-plane-web typecheck
pnpm --filter @nest-mcp/control-plane-web test
pnpm --filter @nest-mcp/control-plane-web build
```

## Schema-driven tool arguments

The tool console deliberately uses JSON Schema Draft 2020-12 as its UI boundary. Public server
APIs can still be authored with Zod or any other implementation of Standard Schema plus Standard
JSON Schema; MCP discovery projects that contract into a portable `inputSchema`, which is what the
browser receives. Standard Schema itself is a validation interface and does not expose enough
portable shape information to generate form controls safely.

The private web app compiles a conservative subset of each advertised schema into an app-local
field model. It renders nested objects, strings and enums, numbers, integers, booleans, and typed
arrays, while ambiguous constructs fall back to raw JSON. CodeMirror is loaded only when a JSON
editor or an opened JSON details panel needs it, and provides syntax diagnostics and formatting.
Submission is still revalidated by the API against the discovered tool definition before dispatch;
the browser form is an interaction aid, not the trust boundary.

All renderer code, editor dependencies, and tests live under this `private: true` app. Release
scripts enumerate only `packages/*`, and published packages use explicit file allowlists, so none
of this UI surface or its CodeMirror dependency graph is included in npm tarballs.

## Production routing

Production must put the UI and API behind one trusted reverse proxy. Route `/api/*` to the
control-plane API while stripping `/api`, route the inbound `/mcp/hub` path to the API unchanged,
and serve everything else from this app. Do not solve this by enabling browser CORS or exposing port
`3400` publicly—the control plane is a private administrative surface and the API intentionally has
no cross-origin browser contract.

Protect the reverse proxy with the deployment's administrative authentication and network policy.
The app itself does not add an authentication layer. Tool calls can have external side effects, so
do not expose this validation console as a public endpoint.

## Data behavior

- Every API response is parsed through Zod. Control-plane envelopes are strict; discovered MCP
  items permit additive protocol fields.
- Connection creation selects either no authentication or OAuth without accepting provider
  credentials. OAuth connections are created offline and must be authorized before connecting.
- OAuth authorization uses a top-level native POST navigation through same-origin `/api`; provider
  URLs, callback state, authorization codes, tokens, client IDs, and PKCE material never enter the
  React Query cache or browser storage.
- The browser accepts only a bounded callback result marker, removes it from the address bar
  immediately, and refreshes the safe connection projection. OAuth authorization state is held by
  the API process only and is cleared on restart.
- Mutations never retry automatically and send the current revision for compare-and-swap updates.
- Adding or removing an MCP from the unified endpoint pins the current connection revision and live
  runtime generation internally. Those routing details stay out of the management UI.
- Unified-endpoint inclusion and discovery state live only in API process memory. The browser does
  not persist them, and an API restart clears the endpoint.
- Connection and runtime queries poll only while state can reconcile (`queued`, `connecting`,
  `degraded`, `draining`, pending leases, or closing leases).
- The header reports API liveness and readiness from separate health checks. A reachable API whose
  manager is closed is shown as not ready rather than healthy.
- The metrics snapshot polls every five seconds while the document is active. Its counters,
  low-cardinality operation groups, rolling buckets, and bounded histogram estimates live only in
  API process memory and reset when the API restarts; the browser does not persist or reconstruct
  metric history.
- Metrics charts use semantic figures, ordered bucket lists, exact non-color labels, and native
  tables. Raw telemetry attributes and logical targets are not part of the browser contract.
- Catalog cache entries include both connection ID and runtime generation, preventing a retired
  endpoint's discovery data from being shown for its replacement.
- Tool arguments support nested object fields, strings and enums, numbers, integers, booleans, and
  typed arrays. A complex property or array item that cannot be mapped faithfully (for example an
  ambiguous `anyOf`, `oneOf`, or `$ref`) stays in a field-local JSON editor while supported sibling
  fields remain interactive. Only an unsupported root schema switches the entire editor to raw JSON.
- Tool calls require a deliberate click, are limited to a 64 KiB argument object, and are never
  retried automatically. The API revalidates against the pinned discovered definition before
  dispatch and supplies that definition to the client runtime for structured-output validation.
  Tools that require MCP task execution stay disabled until the API exposes a task lifecycle
  contract.
- Tool results stay in dialog memory only. Text is rendered as text, binary content and resource
  links are metadata-only, and large previews are bounded. Upstream annotations are advisory;
  tools marked destructive require an additional confirmation.
- Concrete resource reads and prompt rendering use the same explicit, non-retried interaction
  model. Prompt arguments and rendered results are bounded; binary content is summarized instead
  of embedded.
- Current observations are displayed as individual pass, warning, or unknown checks derived from
  the safe runtime and catalog projections; the console does not invent an aggregate readiness
  score from them.
- Repeatable conformance is separate evidence: the browser starts only the fixed passive plan,
  scopes history by connection and runtime generation, polls only an active run, and never retries
  start or cancellation mutations. The API retains a bounded process-local report history and the
  panel displays its five most recent reports; an API restart clears them.
- The projected Hub catalog is revision-fenced, cached by Hub revision, and exposes reversible
  namespace/source to projected-name and projected-URI mappings without fetching from inside the
  explorer component.
