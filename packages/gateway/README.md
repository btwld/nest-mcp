# @nest-mcp/gateway

Policy-enforced MCP v2 gateway composition for exposing tools, prompts, concrete resources, resource templates, and completion from multiple upstream MCP clients through an `@nest-mcp/server` feature.

> This package is alpha. Public APIs may change before the first stable release.

## Design guarantees

- Collision-free, reversible aggregate tool and prompt names. Components are independently UTF-8/base64url encoded; names are never parsed with an ambiguous separator split and are bounded to 128 characters.
- Concrete upstream resource URIs are replaced on the wire by canonical, reversible `mcp-gateway://` routing URIs. Raw URIs do not appear in projected names or telemetry attributes, and resource URIs inside prompt/tool content and read results are rewritten too.
- Resource templates use a separate reversible URI-template namespace and bounded projected names. Prompt and template completion references are decoded only at the upstream boundary.
- Discovery is cached and singleflight-coalesced by both upstream and authorization context. Shared refresh count, duration, pages, items, structural depth, string/item/snapshot bytes, and in-memory cache bytes are bounded.
- Authorization is fail closed. Policy filters discovery and is checked again before every tool call, prompt get, concrete/template resource read, and completion. Execution checks run before user middleware and upstream calls.
- Raw upstream discovery is cached, not an authorized view. Policy changes therefore take effect without waiting for cache expiry.
- Structural upstreams receive the official tool definition plus `allowInputRequired: true`. The first-party runtime adapter uses manual MRTR request mode to prevent auto-approval; see the explicit SDK boundary below.
- Middleware and payload-safe lifecycle events compose through `@nest-mcp/core`.
- Prompt/resource/resource-template policy hooks are opt-in and fail closed when absent, so a tool-only policy cannot accidentally expose new capabilities after an upgrade.

## Installation

```sh
pnpm add @nest-mcp/gateway@alpha @nest-mcp/client@alpha @nest-mcp/server@alpha @modelcontextprotocol/node@2 @modelcontextprotocol/server@2
```

## Create an aggregate gateway

```ts
import { allowMcpOperation, denyMcpOperation } from "@nest-mcp/core";
import { McpGateway, type McpGatewayPolicy } from "@nest-mcp/gateway";
import type { McpServerDefinition } from "@nest-mcp/server";

const policy: McpGatewayPolicy = {
	authorize(operation) {
		const auth = operation.context.principal;
		if (auth === undefined) return denyMcpOperation("Authentication is required.");
		if (operation.input.toolName === "delete_everything") {
			return denyMcpOperation("Destructive tools are disabled.");
		}
		return allowMcpOperation({ policy: "artifact-agent-policy" });
	},
	authorizePrompt(operation) {
		return operation.context.principal === undefined
			? denyMcpOperation("Authentication is required.")
			: allowMcpOperation();
	},
	authorizeResource(operation) {
		return operation.context.principal === undefined
			? denyMcpOperation("Authentication is required.")
			: allowMcpOperation();
	},
	authorizeResourceTemplate(operation) {
		return operation.context.principal === undefined
			? denyMcpOperation("Authentication is required.")
			: allowMcpOperation();
	},
};

const gateway = new McpGateway({
	upstreams: [
		{ name: "github", client: githubClient },
		{ name: "observability", client: observabilityClient },
	],
	policy,
	// The default resolver safely partitions by principal dimensions and bearer fingerprint.
});

export const gatewayServer = {
	name: "agent-gateway",
	serverInfo: { name: "agent-gateway", version: "1.0.0" },
	features: [gateway.asServerFeature()],
} satisfies McpServerDefinition;
```

`McpGatewayClient` is intentionally structural and capability-complete. An official v2 `Client` can be supplied directly. Existing `McpGatewayToolClient` implementations remain valid: prompts, concrete resources, templates, and completion are projected only when their required structural methods and advertised upstream capabilities are present. A resolver may be supplied instead when the correct upstream connection depends on tenant, principal, or credential state:

```ts
const gateway = new McpGateway({
	upstreams: [
		{
			name: "tenant-tools",
			client: async (context) =>
				connectionPool.getClient({
					authorizationContext: context.authorizationContext,
					signal: context.signal,
				}),
		},
	],
	policy,
});
```

For the first-party multi-server client runtime, use the named-server adapter:

```ts
import { McpClientRuntime } from "@nest-mcp/client";
import { McpGateway, createMcpClientRuntimeUpstream } from "@nest-mcp/gateway";

const clients = new McpClientRuntime({ servers });
const gateway = new McpGateway({
	upstreams: [
		createMcpClientRuntimeUpstream(clients, "github"),
		createMcpClientRuntimeUpstream(clients, "grafana", "observability"),
	],
	policy,
});
```

## Dynamic upstream topology

Set `dynamicUpstreams: true` when an application-owned control plane must publish already-admitted
upstreams without rebuilding its Nest application or inbound HTTP runtime:

```ts
const gateway = new McpGateway({
	dynamicUpstreams: true,
	upstreams: [],
	policy,
});

const attached = await gateway.attachUpstream(
	{ name: freshRouteId, client: managedClient },
	{ expectedRevision: gateway.topology().revision },
);

await gateway.detachUpstream(freshRouteId, { expectedRevision: attached.revision });
```

Mutations are serialized and optionally compare-and-swap fenced. `topology()` exposes only the
process-local revision and routing names; upstream clients and credentials are never projected.
`replaceUpstream()` swaps one routing identity atomically. Accepted requests retain the immutable
topology snapshot they captured, while later requests see the committed topology.

Use a fresh, non-secret routing identity for every attachment generation. Do not reuse a detached
name for different runtime material: a fresh identity ensures a held old tool, prompt, or resource
identifier can only become stale, never target a replacement generation. Human display aliases and
tenant/workspace authority belong in the host control plane, not in `McpGateway`.

Dynamic mode advertises tools, prompts, and resources from the empty topology and declares
`listChanged: true`. After a successful topology commit, the owning persistent
`McpServerRuntime.notify` must emit `toolsChanged()`, `promptsChanged()`, and
`resourcesChanged()`. The gateway cannot emit those itself because it is framework-neutral and may
be hosted by more than one runtime. Resource subscriptions and upstream notification bridging are
still unavailable.

## Lifecycle

`McpGateway` implements `AsyncDisposable`. `close()` is idempotent: it rejects new work with
`GATEWAY_CLOSED`, aborts accepted discovery and execution through their request signals, and waits
for gateway-owned work and cache queues to settle. `shutdownTimeoutMs` bounds that wait at 30
seconds by default; an upstream or cache implementation that ignores cancellation produces
`GATEWAY_SHUTDOWN_TIMEOUT` instead of hanging shutdown indefinitely.

For framework-neutral composition, stop the inbound server first, then close the gateway, then
close the clients that own its upstream connections:

```ts
await gatewayServerRuntime.close();
await gateway.close();
await clients.close();
```

## Cache isolation

`McpGatewayDiscoveryCacheKey` always contains `upstreamName` and `authorizationContext`. The default `InMemoryMcpGatewayDiscoveryCache` provides TTL expiration plus entry-count and total-byte weighted LRU eviction (64 MiB by default). Inject a shared cache for multi-process deployments, but retain both key dimensions and equivalent memory bounds.

Concurrent misses for the same key share one in-process refresh across tools, prompts, concrete resources, and resource templates. Every refresh has a gateway-owned timeout (60 seconds by default); abandoned work is signalled to abort, and its concurrency slot remains occupied until the raw upstream promise actually settles even when a structural client ignores that signal. New authorization contexts fail with `DISCOVERY_OVERLOADED` after the configured concurrent-flight limit (64 by default). Discovery follows raw `nextCursor` pages independently for each capability, with repeat detection, `discoveryMaxPages` (64), `discoveryMaxItemsPerCapability` (10,000), `discoveryMaxItemBytes` (256 KiB), `discoveryMaxSnapshotBytes` (8 MiB), `discoveryMaxDepth` (64), and `discoveryMaxStringBytes` (64 KiB), including cursors. These are payload limits after transport parsing; configure HTTP body limits at the host boundary too. The first-party adapter deliberately uses the client's method-keyed request funnel so gateway bounds apply before official helper-level aggregation; structural clients must preserve each raw page.

Application-owned change handling can call `invalidateDiscovery(key)` for one partition or
`invalidateAllDiscovery()` for every partition. Global invalidation aborts older refreshes and uses
a cache barrier so stale writes cannot repopulate the cache after the clear. `close()` never clears
an injected cache because that cache may be shared by other gateway instances.

The default authorization-context resolver hashes every available identity dimension: pre-resolved client ID, explicit subject, explicit tenant ID, sorted scopes, and resource, plus a bearer-token fingerprint when `authInfo` is also present. Without a principal it uses `SHA-256(access_token)`; without either it uses `anonymous`. A token rotation intentionally creates a new cache entry even when the projected principal is unchanged. For application-specific policy dimensions or upstream credential generations, provide your own opaque resolver key. Never use a bearer token itself as that key.

## Middleware and lifecycle

Gateway middleware wraps upstream discovery and execution. Execution policy is enforced before middleware can reach upstream work. Lifecycle events contain bounded projected names and errors but omit arguments, completion values, raw URI templates, and results.

```ts
import {
	McpGateway,
	createMcpGatewayPassthroughMiddleware,
	defineMcpGatewayTransform,
} from "@nest-mcp/gateway";

const tracePropagationMiddleware = createMcpGatewayPassthroughMiddleware(
	async (operation, next) => {
		trace.enter(operation.context);
		await next();
		trace.leave(operation.context);
	},
);

const invocationTransform = defineMcpGatewayTransform(
	"gateway.invocation",
	async (operation, next) => {
		const result = await next(); // CallToolResult, without a union or cast
		return { ...result, _meta: { ...result._meta, routedTool: operation.input.toolName } };
	},
);

const gateway = new McpGateway({
	upstreams,
	policy,
	middleware: [tracePropagationMiddleware, concurrencyLimitMiddleware, invocationTransform],
	lifecycleObserver: {
		onEvent(event) {
			telemetry.record(event);
		},
	},
});
```

Prefer `createMcpGatewayPassthroughMiddleware` for tracing, logging, concurrency limits, and other
concerns that must preserve the exact downstream result. Its callback sees `next()` as
`Promise<void>`, so a discovery snapshot cannot be accidentally returned from an invocation (or
vice versa). For deliberately transforming middleware, `McpGatewayOperationOutputMap` and
`McpGatewayOperationOutputFor<Input>` expose the discriminator-to-result relationship.
`defineMcpGatewayTransform(kind, transform)` applies that relationship directly, so the callback
receives only the selected input and result. Exact transforms are placed downstream of general
middleware, preserving relative order within each group, so their typed `next()` cannot receive a
different operation's result from a legacy broad transform. Mandatory
invocation/prompt/resource authorization remains outermost and therefore runs before every user
transform, including one that short-circuits without calling `next()`. Abort checks surround each
transform, lifecycle observation remains outside the secured chain, and the shared continuation
retains next-once enforcement. Official fields returned by a transform, including
`structuredContent` and `_meta`, are retained. The existing trust boundary still strips opaque
upstream `_meta` before a result reaches a transform.

## Naming

`GatewayNameCodec` produces canonical tool/resource names shaped like `gw1.<server-base64url>.<name-base64url>`. `GatewayPromptNameCodec` uses a separate `gwp1` namespace. Use `decode()` to route them and `tryDecode()` when inspecting names from an untrusted mixed namespace. Custom codecs must remain reversible, injective, and bounded.

`GatewayResourceUriCodec` projects a concrete URI as `mcp-gateway://v1/<server-base64url>/<uri-base64url>`. Base64url is a reversible routing representation, not encryption or redaction: anyone receiving the projected URI can decode the upstream URI. Never put credentials or secret values in upstream URIs. The default codec rejects URI userinfo credentials, but generic query values cannot be classified automatically. It also validates canonical syntax, absolute upstream URIs, and an 8,192-character maximum. Use a keyed, application-owned mapping codec when identifiers themselves must remain secret.

`GatewayResourceTemplateUriCodec` projects a template into `mcp-gateway-template://v1/<server-base64url>/<template-base64url>/values/{variables...}` and defaults template names to the separate `gwrt1` namespace. The base64url component is equally reversible and provides namespacing, not confidentiality. The codec requires at least one canonical variable, rejects templates that expand to URI userinfo credentials, and applies URI-length and variable-count bounds. Upstream templates must not carry secrets in any component; use an application-owned keyed codec when their identifiers are confidential.

Projected template routes support scalar, single-variable RFC 6570 expressions. List/explode (`*`), prefix (`:N`), and multi-variable expressions are rejected during discovery because the official high-level match callback does not preserve enough type information to round-trip them safely. Captured values are decoded exactly once and must reproduce the concrete projected URI canonically.

MCP recommends tool names remain within 128 characters. Because a stateless reversible encoding cannot compress every possible server/tool pair into that bound, the default codec rejects projections longer than 128 characters. Choose concise upstream aliases and tool names, or inject a bounded registry-backed codec whose mapping lifecycle matches the gateway.

## Security notes

- `policy` is mandatory. `allowAllMcpGatewayPolicy()` is an explicit opt-in for an already trusted and isolated environment.
- Filtered discovery is a usability control; call-time authorization is the security boundary.
- Tool results and prompt messages containing links to concretely discovered resources are rewritten into gateway URIs before returning to the caller. A link absent from authorized `resources/list` is rejected fail closed because this alpha cannot register a corresponding read route safely.
- A template read rewrites the requested expanded URI into the projected template namespace. Any additional returned URI must have an authorized concrete-resource route or the response is rejected fail closed.
- Upstream clients and their credentials are owned by the application or `@nest-mcp/client`, not by the gateway feature.
- Apply egress controls, credential storage, OAuth refresh serialization, rate limits, and concurrency limits at the client/runtime boundary.
- Do not put secrets or high-cardinality request identifiers in metrics labels.
- Arbitrary upstream `_meta` is stripped. Downstream definitions receive only the bounded `nest-mcp/gateway` projected routing marker; applications should not rely on vendor metadata crossing the gateway.

## Current capability boundary

This alpha projects tools, prompts, concrete resources, resource templates returned by `resources/templates/list`, and completion for projected prompt/template references. It does not synthesize a template `list` callback: concrete instances remain sourced independently from `resources/list`. Completion results are validated against the protocol's 100-value bound.

The gateway installs one low-level `completion/complete` handler. It preserves the upstream `values`, `total`, and `hasMore` fields and forwards the downstream request's cancellation signal.

Multi-round-trip `input_required` flows are not proxied. Every generic structural execution requests manual mode with `allowInputRequired: true`. Any continuation fails closed with `UPSTREAM_INPUT_REQUIRED`, so the gateway never silently invokes configured input handlers. For tools, the first-party runtime adapter retains official `Client.callTool` SEP-2243 `x-mcp-header` preparation while passing a definition without `outputSchema`; it compiles the original schema before invocation and validates complete structured output locally. This ordering prevents the official plain-result helper from treating `input_required` as missing structured output without dropping either header or schema semantics. Transparent relay needs a separately sealed, route-bound continuation design.

Transport/client response-body limits remain mandatory for production. Gateway discovery adds post-parse structural and byte bounds, but execution results (tool, prompt, resource, and completion payloads) can already have been allocated by a custom structural client before the gateway receives them; configure equivalent upstream response limits at that boundary.

The gateway does not bridge upstream subscription streams or resource subscriptions. Static mode
advertises `listChanged: false`; dynamic mode advertises `listChanged: true` and requires its host
to publish invalidations after committed topology changes as described above. Both modes advertise
`subscribe: false` for resources. `asServerFeature()` remains dedicated-server-only in this alpha:
pre-existing tool, prompt, resource, completion handlers or notification capability ownership
produce `CAPABILITY_CONFLICT`. Run local decorated capabilities on a separate MCP server. Call
`invalidateDiscovery()` for one upstream/authorization partition or `invalidateAllDiscovery()` for
a concurrency-safe global clear from application-owned change handling.

## Entry points

- `@nest-mcp/gateway`
- `@nest-mcp/gateway/testing`

## License

BSD-3-Clause
