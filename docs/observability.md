# Observability

Nest MCP separates logical-operation telemetry from wire-attempt telemetry. This prevents retries, OAuth negotiation, discovery probes, and per-request server construction from being collapsed into one misleading signal.

## Signal layers

| Layer                            | Observes                                            | Appropriate uses                                                   |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| Core/runtime middleware          | One logical client or gateway operation             | authorization outcome, end-to-end latency, routing, business audit |
| Nest handler pipeline            | One validated tool/resource/prompt callback         | per-capability authorization, duration, denial, cancellation       |
| Official client fetch middleware | Each HTTP request/response attempt                  | DNS/network latency, discovery probes, OAuth, retries, HTTP status |
| Server HTTP middleware           | One complete HTTP exchange before official dispatch | coarse HTTP latency, rate limits, transport authentication         |
| Server runtime observer          | Server build, handler error, and close phases       | per-request factory cost, registration failure, lifecycle health   |
| Host/Nest telemetry              | Application request and process lifecycle           | inbound route, tenant context, deployment, graceful shutdown       |

The official SDK's framework packages are hosting adapters, not client fetch middleware. A
separately mounted Node handler also does not automatically pass through Nest interceptors or
guards. Framework-neutral `McpServerDefinition.middleware` wraps HTTP only; Nest servers reference
injectable providers for this layer. Use `handlerLifecycleObserver` and `handlerMiddleware` for
decorated callbacks that must be observed consistently over HTTP and stdio.

## Core lifecycle events

`@nest-mcp/core` defines the event contracts consumed directly by client, gateway, and Nest handler pipelines:

- `operation.started`;
- `operation.succeeded` with duration;
- `operation.failed` with sanitized error details; and
- `operation.cancelled` when the operation rejects after its signal is aborted.

Every event carries the immutable operation context and a Unix epoch timestamp. Context includes operation ID, runtime role, method/name, kind, optional capability and target, abort signal, optional request/session correlation, optional safe principal, and low-cardinality attributes.

Events intentionally omit operation input and output. Error details contain a small name/message/code projection and do not include stack traces by default.

## Middleware ordering

Nest MCP logical middleware uses left-to-right entry and right-to-left exit:

```ts
composeMcpMiddleware([lifecycle, authorization, deadline], terminal);
```

`lifecycle` is outermost, so denials and deadline failures are recorded. Calling `next()` twice
raises a typed re-entry error. Nest server definitions preserve this ordering through singleton
provider tokens: `handlerLifecycleObserver.onEvent` surrounds mandatory
`handlerAuthorization.authorize`, followed by each `handlerMiddleware.handle` and the validated
callback.

The official client fetch composition has a different convention: the last middleware passed to `applyMiddlewares` is outermost, and the first sits closest to the network. Keep attempt-level retry closest to the network so higher layers see one settled response.

## Failure isolation

Telemetry must not change protocol behavior:

- lifecycle observer rejection does not replace a successful result;
- observer rejection does not replace the operation's primary error;
- an optional observer-error callback may report exporter failures;
- failures in that callback are also isolated; and
- composed observers attempt every destination before surfacing one or aggregate failures.

Server `onError` callbacks and runtime observers follow the same best-effort principle. Exporters should have bounded queues, timeouts, and backpressure; never await an unbounded remote exporter in the MCP request path.

## Recommended semantic fields

Adapters should use stable, low-cardinality names. A proposed mapping is:

| Field                      | Example                       |
| -------------------------- | ----------------------------- |
| `mcp.runtime.role`         | `client`, `server`, `gateway` |
| `mcp.operation.name`       | `tools/call`                  |
| `mcp.operation.kind`       | `request`                     |
| `mcp.operation.capability` | `tools`                       |
| `mcp.operation.target`     | `artifact-storage`            |
| `mcp.transport.kind`       | `http`, `stdio`               |
| `mcp.protocol.era`         | `modern`, `legacy`            |
| `mcp.protocol.version`     | `2026-07-28`                  |
| `mcp.authorization.effect` | `allow`, `deny`               |
| `mcp.authorization.policy` | stable policy identifier      |
| `mcp.error.code`           | stable runtime/SDK code       |

The first five are the standard projection from `@nest-mcp/observability`; target can be disabled. Transport, protocol, authorization, and error dimensions must be supplied through an explicit selector or event-specific adapter and still pass redaction and cardinality limits.

Do not use tool arguments, URIs containing user data, prompts, result text, access tokens, complete user IDs, or raw exception stacks as metric labels.

## Traces

Suggested span hierarchy for an artifact agent call:

```text
agent capability invocation
└── mcp.gateway tools/call
    ├── authorization decision
    └── mcp.client tools/call [artifact-storage]
        ├── server/discover HTTP attempt (only when needed)
        ├── OAuth/token HTTP attempt (only when needed)
        └── MCP HTTP attempt
            └── mcp.server tools/call
```

Use the Nest MCP operation ID as correlation, not necessarily as the trace ID. Inject standard trace context through HTTP headers, and define an explicit propagation strategy for stdio or custom transports. A gateway fan-out should link child upstream spans and record partial failure without pretending the calls were sequential.

## Metrics

Useful starting metrics:

- logical operations by role, operation, target, and outcome;
- logical duration histogram;
- authorization decisions by policy and effect;
- active/connecting/failed client connections;
- discovery probes, cache hits, stale evictions, and era outcomes;
- HTTP attempts by destination class and status family;
- OAuth refresh/interactive/step-up outcomes without issuer secrets;
- server factory build duration and failures;
- in-flight operations and cancellations;
- gateway fan-out width and partial failures; and
- observer/export queue drops.

Bound target labels to configured server names. Do not use arbitrary URLs or dynamically generated tool names as unbounded metric dimensions.

## Logs and audit events

Operational logs explain runtime health; audit events explain security decisions. Keep them separate when retention and access controls differ.

An authorization audit record should contain:

- timestamp and operation ID;
- safe principal/tenant reference;
- downstream and selected upstream server identifiers;
- operation/capability name;
- allow/deny effect and stable policy identifier;
- credential strategy category, never the credential; and
- result class and duration.

Tool arguments and results should be absent by default. Where regulated auditing requires selected fields, use an explicit schema-aware redaction policy and document retention.

## Server lifecycle observation

`@nest-mcp/server` emits a separate runtime phase stream:

- `build:start`, `build:success`, `build:error`;
- `handler:error`; and
- `close:start`, `close:success`, `close:error`.

Build events identify the runtime and protocol era and can reveal expensive per-request feature registration. They are not substitutes for request lifecycle events. The server runtime observer may receive an `Error`; sanitize it before exporting beyond the process boundary.

## Discovery and OAuth visibility

Automatic version negotiation can add a `server/discover` probe. Reused prior discovery can remove it. Dashboards should distinguish those paths so a cache policy change does not look like unexplained application latency.

Likewise, a logical request can contain token lookup, refresh, interactive authorization, step-up, and one retry. Instrument the fetch/auth layer to see those attempts, while reporting the final logical outcome once at the runtime layer.

An exclusive managed-runtime lease creates and closes one client runtime for one operation, while a
shared online generation amortizes that lifecycle across calls. Dashboards should interpret
connection churn using the host's configured lease strategy rather than treating exclusive cleanup
as instability. Manager state events and built-in lifecycle attributes remain key-free and do not
expose credential bindings or revisions.

## Implemented backend-neutral adapters

`@nest-mcp/observability` translates core lifecycle operations into logs and metrics and supplies tracing middleware without depending on OpenTelemetry, Pino, Prometheus, or another vendor SDK.

Its built-in adapters are:

- `createMcpLoggerObserver`, which emits one immutable structured record per lifecycle event;
- `createMcpMetricsObserver`, which emits batches for started/completed counters, active operations, and duration;
- `createMcpTracingMiddleware`, which creates and activates structural spans and reports static success/error status; and
- `projectMcpTelemetryAttributes`, which bounds attribute count, key length, and string length while dropping unsupported and sensitive values by default.

The default projection reads only runtime role, operation name/kind, capability, and optionally the named target. It does not read operation inputs, principals, arbitrary context attributes, operation/request/session IDs, error messages, stacks, tokens, cookies, or credentials. Application fields require `selectAttributes`; sensitive-looking keys require a separate `allowSensitiveAttribute` decision, and `redactAttribute` can hash, bucket, normalize, or drop the final value.

Implement the small `McpStructuredLogSink`, `McpMetricsSink`, and `McpTracer`/`McpTraceSpan` interfaces for the selected backend. Raw exception recording is disabled unless `recordError` is provided explicitly. Instrumentation failures, including custom clock failures, are reported through hooks and contained so they do not replace an MCP result or primary error.

Server construction phases remain a separate `McpServerRuntimeObserver` stream. Adapt those events explicitly if factory cost and shutdown health must share the same backend.
