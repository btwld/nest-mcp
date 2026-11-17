# Nest MCP

Nest MCP is an alpha-stage Model Context Protocol runtime for NestJS applications, gateways, and agent hosts. It builds on the official MCP TypeScript SDK v2 while adding package boundaries for multi-server client operation, per-request servers, Nest dependency injection, middleware, authorization, and observability.

The primary use case is an artifact or agent runtime that needs to expose trusted application capabilities and consume many MCP servers through one controlled NestJS layer. The runtime is intended to make authentication, authorization, routing, lifecycle ownership, and telemetry explicit rather than hiding them behind a global SDK singleton.

> [!WARNING]
> This repository currently targets stable NestJS `12.0.1`, TypeScript `7.0.2`, MCP SDK `2.0.0`, and Node.js `>=22.13.0`. Every 2.x package is still an alpha prerelease, so expect breaking changes while these packages evolve.

## Packages

| Package                   | Responsibility                                                                                                                                      | Status      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `@nest-mcp/core`          | Framework-neutral operation context, middleware, authorization decisions, and lifecycle observation                                                 | Implemented |
| `@nest-mcp/client`        | Named v2 client runtime, strict outbound OAuth, isolated leases, transports, typed requests, managed listening, and middleware                      | Implemented |
| `@nest-mcp/manager`       | Framework-neutral bounded ownership and lifecycle for opaque, dynamically resolved MCP client generations                                           | Implemented |
| `@nest-mcp/conformance`   | Framework-neutral bounded probe execution, immutable reports, hostile-value capture, fingerprints, and catalog-drift digests                        | Alpha       |
| `@nest-mcp/server`        | Framework-neutral per-request server runtime, feature registry, web-standard/Node/stdio serving, and OAuth resource-server wrapper                  | Implemented |
| `@nest-mcp/apps`          | Stable MCP Apps server metadata, validation, decorator/native fragments, capability advertisement, and direct-server feature composition            | Alpha       |
| `@nest-mcp/gateway`       | Tool, prompt, resource, resource-template, and completion projection with policy enforcement and auth-scoped discovery caching                      | Implemented |
| `@nest-mcp/auth`          | OAuth toolkit: Client ID Metadata Document resolution, SSRF-hardened discovery fetch, bounded token stores, and asymmetric JWT issuing/verification | Alpha       |
| `@nest-mcp/observability` | Backend-neutral structured logging, metrics, tracing, bounded attributes, and redaction policies                                                    | Implemented |
| `@nest-mcp/nestjs`        | NestJS module, decorators, validated handler pipelines, named client integration, dependency injection, and application lifecycle                   | Implemented |

The dependency graph keeps protocol/runtime code below the Nest adapter:

```mermaid
flowchart BT
  core["@nest-mcp/core"]
  client["@nest-mcp/client"] --> core
  manager["@nest-mcp/manager"] --> core
  manager --> client
  conformance["@nest-mcp/conformance"]
  server["@nest-mcp/server"] --> core
  apps["@nest-mcp/apps"] --> server
  gateway["@nest-mcp/gateway"] --> core
  gateway --> client
  gateway --> server
  auth["@nest-mcp/auth"] --> core
  auth --> server
  observability["@nest-mcp/observability"] --> core
  nest["@nest-mcp/nestjs"] --> core
  nest --> server
  nest --> client
  nest --> manager
  nest --> gateway
  nest --> auth
```

`@nest-mcp/core` is not a replacement for `@modelcontextprotocol/core`: the Nest MCP package owns runtime composition contracts, while the official package owns raw protocol schemas. Client and server adapters depend only on the official SDK packages they actually use.

## Install

The packages currently publish on the `alpha` dist-tag. Install the NestJS integration with its
required peers:

```sh
pnpm add @nest-mcp/nestjs@alpha @modelcontextprotocol/client@2 @modelcontextprotocol/core@2 @modelcontextprotocol/node@2 @modelcontextprotocol/server@2 @nestjs/common@12 @nestjs/core@12 reflect-metadata rxjs zod@^4.4.3
```

Framework-neutral applications can instead install the individual `@nest-mcp/*@alpha` packages
they use.

## MCP manager applications

The private [`apps/control-plane-api`](apps/control-plane-api) NestJS application validates dynamic
desired state, the public `@nest-mcp/manager` lifecycle, generation replacement, catalog discovery,
operation execution, repeatable `@nest-mcp/conformance` reports, bounded process-local metrics, and
a live aggregate `/mcp/hub` whose upstreams can be attached or detached without restarting. The companion
[`apps/control-plane-web`](apps/control-plane-web) application is an Inspector-style local manager
built with Vinext, React, Tailwind, shadcn, TanStack Query, and Zod. Run both with `pnpm dev`.

These applications deliberately keep connection authority and admission policy outside the
published libraries. They validate the control-plane boundary for a future product-host adapter
without turning tenant, workspace, credential, approval, or persistence concerns into
`@nest-mcp/nestjs` behavior.

## MCP v2 model

The modern `2026-07-28` protocol era is per-request:

- `server/discover` advertises the server instead of opening with `initialize`.
- HTTP requests carry their own `_meta` envelope.
- There is no modern `Mcp-Session-Id` session.
- `createMcpHandler` creates a fresh `McpServer` from a factory for each request.

Nest MCP follows that model. Server features register tools, resources, and prompts on the fresh request instance. Long-lived database pools, registries, caches, and brokers belong in Nest providers or closures outside the factory. The same official handler can serve 2025-era clients in stateless compatibility mode; sessionful legacy transports are an explicit deployment choice rather than the core runtime model.

See [Architecture](docs/architecture.md) for state ownership and protocol-era details.

## Local development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run verify:pack
```

The workspace uses pnpm `11.20.0`, ESM-only package output, explicit export maps, tsdown, strict TypeScript project references, Vitest, oxlint, Prettier, publint, and Changesets.

## Consume multiple servers

`@nest-mcp/client` owns one official `Client` per named upstream and applies one logical-operation policy across them:

```ts
import { McpClientRuntime } from "@nest-mcp/client";

const runtime = new McpClientRuntime({
	servers: [
		{
			name: "artifact-storage",
			transport: {
				kind: "http",
				url: "https://mcp.example.com/storage",
				authProvider,
			},
			clientOptions: { versionNegotiation: { mode: "auto" } },
		},
	],
	middleware: [policyMiddleware, auditMiddleware],
	observer: lifecycleObserver,
});

try {
	await runtime.connect("artifact-storage");
	const tools = await runtime.listTools("artifact-storage");
	console.log(tools.tools.map(({ name }) => name));
} finally {
	await runtime.close();
}
```

Discovery verdicts may be reused through the official SDK's `PriorDiscovery` support, but cache freshness and authorization-context isolation remain the host's responsibility.

The runtime also exposes typed general requests, completion, manual modern `input_required` rounds, and runtime-owned modern `listen()` handles. Manual multi-round APIs return the official continuation instead of invoking configured auto-fulfilment handlers; each resumed leg re-enters runtime middleware and lifecycle observation. Disconnecting an upstream closes its active subscriptions before the official client and transport. The older `resources/subscribe` and `resources/unsubscribe` delegates are explicitly legacy-only.

`McpClientRuntime` remains framework-neutral and directly constructible. In a Nest application,
`@nest-mcp/nestjs` supplies `McpClientModule` and its injectable `McpClientService` subclass, which resolve
client collaborators through Nest, optionally connect during application bootstrap, and close during
module shutdown. An outbound-only agent host can import `McpClientModule.forRoot()` directly and
inject `McpClientService`; a server or gateway root imports the configured client module through
`McpModule` as shown below.

## Build an artifact or agent gateway

`@nest-mcp/gateway` projects tools, prompts, concrete resources, resource templates, and completion from named upstream clients into one MCP server. Names and resource routes are reversible and collision-safe, discovery is isolated by authorization context, and the required capability-specific policy runs during listing and again immediately before execution.

```ts
import { Injectable, Module } from "@nestjs/common";
import { McpClientModule, McpModule, allowMcpOperation, denyMcpOperation } from "@nest-mcp/nestjs";
import type { McpGatewayPolicy } from "@nest-mcp/gateway";

@Injectable()
class AgentGatewayPolicy implements McpGatewayPolicy {
	authorize: McpGatewayPolicy["authorize"] = (operation) => {
		return operation.input.toolName === "artifact.delete"
			? denyMcpOperation("Destructive tools require a separate approval path.")
			: allowMcpOperation({ policy: "artifact-agent-v1" });
	};

	authorizePrompt() {
		return allowMcpOperation({ policy: "artifact-agent-v1" });
	}

	authorizeResource() {
		return allowMcpOperation({ policy: "artifact-agent-v1" });
	}

	authorizeResourceTemplate() {
		return allowMcpOperation({ policy: "artifact-agent-v1" });
	}
}

@Module({
	imports: [
		McpModule.forRoot({
			imports: [
				McpClientModule.forRoot({
					servers: upstreamServers,
					bootstrap: {
						connectAll: true,
					},
				}),
			],
			collaborators: { providers: [AgentGatewayPolicy] },
			servers: [
				{
					name: "agent-gateway",
					serverInfo: { name: "agent-gateway", version: "1.0.0" },
					gateway: {
						upstreams: ["artifact-storage", "knowledge"],
						policy: AgentGatewayPolicy,
					},
				},
			],
		}),
	],
})
export class AgentGatewayModule {}
```

The declarative gateway owns the server-wide tool, prompt, resource, and completion handlers.
Gateway servers are therefore dedicated in this alpha: put local/decorated capabilities on a
separate named server rather than composing semantics that cannot be honored for every projected
capability.

Protect the downstream HTTP handler as an OAuth resource server and keep every upstream credential owned by its client definition. The gateway never forwards the downstream bearer token automatically. Prompt, resource, and resource-template policy hooks are fail closed when omitted, so adding an upstream capability cannot expose it through an existing tool-only policy. In a Nest application, string and `{ clientName }` gateway entries use module-owned named clients as service identities. For delegated, token-exchanged, or user-owned upstream credentials, register an `McpGatewayClientProvider` and reference it with `{ name, clientProvider: ProviderToken }`; its `resolveClient()` method receives the verified request context and must return an authorization-isolated client.

Within `McpModule`, callback-bearing server and gateway collaborators are DI tokens rather than raw
functions or stateful objects. This includes the server JSON Schema validator, request-state
verifier, event bus, gateway codecs, discovery cache, authorization-context resolver, middleware,
lifecycle observer, and observer-error reporter. Register their singleton implementations under
`collaborators.providers`; keep timeouts, limits, cache hints, and other passive values inline. The
framework-neutral `@nest-mcp/server` and `@nest-mcp/gateway` APIs continue to accept raw
implementations directly.

Resource-template discovery/read and prompt/template completion are supported. Dynamic gateways
can publish host-owned list-change invalidations after attach/detach commits. Transparent
multi-round `input_required`, upstream notification bridging, and resource subscriptions are not:
those require sealed route-bound request state and a long-lived, authorization-partitioned
subscription coordinator.

## Expose Nest providers as MCP capabilities

```ts
import { Injectable, Module } from "@nestjs/common";
import { McpClientModule, McpModule, Tool, fromJsonSchema } from "@nest-mcp/nestjs";

@Injectable()
class ArtifactTools {
	@Tool({
		name: "artifact.read",
		servers: "artifact-tools",
		inputSchema: fromJsonSchema<{ id: string }>({
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		}),
	})
	read({ id }: { id: string }) {
		return { content: [{ type: "text" as const, text: id }] };
	}
}

@Module({
	imports: [
		McpModule.forRoot({
			imports: [
				McpClientModule.forRoot({
					servers: upstreamServers,
					bootstrap: {
						connectAll: true,
					},
				}),
			],
			collaborators: { providers: [AgentGatewayPolicy] },
			servers: [
				{
					name: "artifact-tools",
					serverInfo: { name: "artifact-tools", version: "1.0.0" },
				},
				{
					name: "agent-gateway",
					serverInfo: { name: "agent-gateway", version: "1.0.0" },
					gateway: {
						upstreams: ["artifact-storage", "knowledge"],
						policy: AgentGatewayPolicy,
					},
				},
			],
		}),
	],
	providers: [ArtifactTools],
})
export class AppModule {}
```

Use `McpClientModule.forRootAsync()` when upstream definitions come from application
configuration, and import the result through `McpModule`:

```ts
McpModule.forRoot({
	imports: [
		McpClientModule.forRootAsync({
			imports: [RuntimeConfigModule],
			inject: [RuntimeConfigService],
			useFactory: (config: RuntimeConfigService) => ({
				servers: config.mcpServers(),
				bootstrap: {
					connectAll: true,
				},
			}),
		}),
	],
});
```

Use `McpModule.forRootAsync()` separately for asynchronous inbound server definitions. Both modules
are local by default. Import the MCP server root exactly once per Nest application because decorator
discovery is application-wide; configure `McpClientModule` independently. Set `isGlobal: true` on
either module only when application-wide injection is intentional.

Declare `httpRoutes: [{ serverName: "artifact-tools", path: "mcp" }]` on `McpModule` to register
Nest HTTP routes without wrapper controllers. With `forRootAsync()`, this option belongs beside
`useFactory`. Route decorators, versioning, and optional public OAuth discovery are documented in
the [Nest adapter guide](packages/nestjs/README.md#declarative-nest-http-routes).

After Nest application bootstrap, inject `McpRuntimeService`. Use `runtime.server("artifact-tools")` for the local inbound server, `runtime.clients` or `runtime.client(name)` for upstreams from the imported client module, and `runtime.gateway("agent-gateway")` to inspect or invalidate the dedicated server's aggregate discovery cache. Inject `McpClientService` directly in client-only application services. Shutdown closes inbound server handlers before closing upstream clients. The Nest destroy hook contains cleanup failures so framework adapter disposal can continue; inspect `runtime.shutdownError` or call `runtime.close()` explicitly when the host must fail on cleanup errors.

Call `app.enableShutdownHooks()` during bootstrap when SIGTERM/SIGINT should trigger Nest lifecycle cleanup. A failed MCP bootstrap automatically rolls back any clients and servers that were already initialized.

Decorated tools, resources, and prompts have a validated, transport-independent callback pipeline:

```ts
McpModule.forRoot({
	collaborators: {
		providers: [
			ArtifactHandlerPolicy,
			DeadlineMiddleware,
			AuditMiddleware,
			ArtifactLifecycleObserver,
		],
	},
	servers: [
		{
			name: "artifact",
			serverInfo: { name: "artifact", version: "1.0.0" },
			handlerAuthorization: ArtifactHandlerPolicy,
			handlerMiddleware: [DeadlineMiddleware, AuditMiddleware],
			handlerLifecycleObserver: ArtifactLifecycleObserver,
		},
	],
});
```

List these collaborator classes under `McpModule`'s `collaborators.providers`. Authorization providers expose
`authorize`, middleware providers expose `handle`, and lifecycle providers expose `onEvent`. The
official SDK validates and routes the request before this pipeline runs. `handlerAuthorization`
cannot be bypassed by custom handler middleware, and `handlerLifecycleObserver` records denials as
well as successes and failures without including callback arguments or results. This is the
correct per-tool/resource/prompt seam for both HTTP and stdio. By contrast, a server's injectable
`middleware` providers surround an HTTP exchange and do not run for stdio.

`@nest-mcp/observability` supplies backend-neutral lifecycle observers for structured logs and metrics plus tracing middleware. Its default projection includes only bounded protocol dimensions; principals, payloads, request/session IDs, error messages, stacks, and credentials require explicit opt-in.

## Safe defaults

- Core authorization enforcement is fail closed: once installed as middleware, a missing policy, thrown policy, malformed decision, or explicit deny never reaches the terminal handler. Protected runtimes must configure that policy explicitly.
- Nest handler authorization runs after official argument validation and before custom handler middleware for every decorated HTTP or stdio invocation.
- Server operation context omits bearer-token material; observers receive a safe principal projection.
- Lifecycle events omit request and response payloads by design.
- Observer failures do not replace protocol results or primary failures.
- Streamable HTTP URLs are constrained to `http:` or `https:`; production hosts should additionally enforce TLS and an outbound destination allowlist.
- Stdio commands are privileged configuration. Never construct commands or environment variables from an untrusted tool call.
- Modern servers are stateless per request. Session affinity is not silently introduced.
- Client OAuth state belongs to the provider, while server bearer verification belongs to the resource-server boundary.

Read [Security and OAuth](docs/security-and-oauth.md) and [Observability](docs/observability.md) before production deployment.

## Documentation

- [Architecture](docs/architecture.md)
- [Security and OAuth](docs/security-and-oauth.md)
- [Observability](docs/observability.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

The vendored `references/` directory is research input and is not part of any published package. The official SDK and MCP specification remain authoritative for wire behavior.

## License

BSD-3-Clause
