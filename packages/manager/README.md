# `@nest-mcp/manager`

A framework-neutral, process-local lifecycle manager for dynamic MCP client generations.

It accepts only an opaque generation key and a host-owned resolver that returns already-admitted
transport material. Connection records, endpoints, credentials, tenancy, approval policy, and
persistence remain in the host application.

## Install

```sh
pnpm add @nest-mcp/manager @nest-mcp/client @modelcontextprotocol/client
```

## Usage

```ts
import { McpRuntimeManager } from "@nest-mcp/manager";

const manager = new McpRuntimeManager({
	generationResolver: {
		async resolve(generationKey, signal) {
			const admitted = await resolveAdmittedTransport(generationKey, signal);
			return {
				transport: admitted.transport,
				close: () => admitted.close(),
			};
		},
	},
	maxConnections: 16,
	maxStateEntries: 1_000,
	shutdownTimeoutMs: 30_000,
});

await manager.ensureOnline("opaque-generation-capability");
const catalog = await manager.refreshCatalog("opaque-generation-capability");
await manager.close();
```

## Shared and exclusive operation leases

The ordinary manager path is generation-shared. `ensureOnline(key)` retains a keeper, and calls for
that key reuse its connected runtime until `setOffline()` or `retire()` drains it. This is suitable
only when the admitted transport and every attached collaborator are safe to pool.

Use `leaseMode: "exclusive"` when one operation must own a fresh runtime and close it before the
operation promise settles:

```ts
const result = await manager.callTool(
	"opaque-generation-capability",
	"search",
	{ query: "lease fencing" },
	{
		leaseMode: "exclusive",
		toolDefinition: approvedDefinition,
	},
);
```

An exclusive operation does not require `ensureOnline()`. It receives a unique internal lease
identity, never joins another acquisition, and holds its global `maxConnections` slot through
runtime and admitted-material cleanup. Shared or second exclusive work for the same generation
fails with `MCP_LEASE_MODE_CONFLICT`; the manager does not hide contention behind an unbounded
queue. Retirement and shutdown still abort the operation and wait for its lease cleanup. A cleanup
failure remains quarantined and capacity-charging.

For concurrent callers that must each use a fresh transport, opt into bounded FIFO waiting:

```ts
const result = await manager.callTool(
	generationKey,
	"search",
	{ query },
	{
		leaseMode: "exclusive",
		exclusiveContention: "queue",
		signal,
	},
);
```

Queued callers wait only behind exclusive operations of the same generation. Each caller resolves
fresh admitted material after the prior operation's runtime and material have fully closed; no
request or result is reused or retried. `requestTimeoutMs` includes queue waiting, admission, and
execution. Caller cancellation removes just that waiter. `setOffline`, `retire`, and `close` reject
pending waiters before they can start; uncertain cleanup rejects them as quarantined. Shared work
or an online keeper remains a lease-mode conflict even when waiting is requested.

`maxQueuedOperations` bounds waiting callers across all generations (default 100). Excess callers
receive `MCP_CAPACITY_EXCEEDED`. Waiting does not consume a connection slot, while active transports
remain bounded by `maxConnections` through cleanup. `snapshot().queuedOperationCount` reports
waiting callers without exposing generation identities. The ordinary exclusive default remains
fail-fast.

This is the manager-side close-on-release primitive for a credential-bound transport that cannot
provide request-correlated OAuth refresh fencing. Do not also retain that generation with
`ensureOnline()`. A host that supplies request-correlated refresh and exact revision fencing may
use the ordinary shared mode instead. Generation keys stay opaque and non-secret in either mode.

`probe`, `refreshCatalog`, `withClientRuntime`, `callTool`, `readResource`, and `getPrompt` accept the
same operation options (or the existing positional `AbortSignal`). `withClientRuntime` remains the
generic route to other protocol methods under an exclusive lease; its callback must not start
parallel credentialed requests when it relies on the minimal OAuth provider's no-concurrency
alternative. The manager-owned exclusive catalog refresh runs its list requests sequentially for
that reason.

## Catalog freshness and change detection

An admitted generation may provide `onConnected(snapshot, signal)`. The manager awaits it once
after successful negotiation and before handing the runtime to an operation. The frozen snapshot
contains the negotiated protocol version, era, capabilities, and connection timestamp. Hosts can
persist a last observation there without keeping a runtime online or making a second probe.
Connection records, timestamp ordering, configuration invalidation, and persistence remain host
policy. This callback is part of acquisition: rejection closes the runtime and admitted material;
best-effort persistence must catch its own errors. Honor the generation signal and keep work bounded.
Ordinary operation cleanup still transitions the current state to offline and removes its active
connection metadata. The hook does not change that lifecycle or the key-free metrics event contract.

`refreshCatalog(key, options)` is the reusable freshness seam. It performs protocol liveness first,
forces every supported list delegate through `cacheMode: "refresh"`, applies the configured page and
item bounds, and only then releases the generation lease. Shared mode runs the list wave in parallel
but waits for every request to settle before release; exclusive mode runs it sequentially so one
minimal OAuth bridge never has concurrent credentialed requests. The frozen `discoveredAt` timestamp
is recorded after the complete successful wave.

The manager deliberately does not persist a baseline or turn list-change notifications into product
state. Compare snapshots with `digestMcpRuntimeCatalog` from `@nest-mcp/conformance`; that canonical,
domain-separated digest is the change seam for approval, persistence, or scheduling owned by the
host. Credential-bound refreshes can combine both guarantees:

```ts
const catalog = await manager.refreshCatalog("opaque-generation-capability", {
	leaseMode: "exclusive",
});
const digest = digestMcpRuntimeCatalog(catalog, {
	domain: "example/mcp/catalog/v1",
	toolSchemaDomain: "example/mcp/tool-schema/v1",
});
```

## Shared runtime ownership

Use `McpRuntimeOwnership` when several host projections can retain the same opaque manager
generation. It composes the manager's existing `retire()` port without taking over product records,
key construction, admission, tenancy, or persistence:

```ts
import { McpRuntimeManager, McpRuntimeOwnership } from "@nest-mcp/manager";

const manager = new McpRuntimeManager({
	generationResolver,
	maxConnections: 16,
});
const ownership = new McpRuntimeOwnership({
	manager,
	maxOwners: 1_000,
	maxGenerations: 1_000,
	maxReferences: 10_000,
});

const workspaceProjection = ownership.createOwner();
await workspaceProjection.retain("opaque-generation-capability");

// The final cooperative owner release retires the manager generation.
await workspaceProjection.release();
```

An owner-to-generation retention is idempotent. Concurrent calls for the same owner and key share
one task. If an older retirement is unsettled, `retain()` waits for that barrier and rechecks the
owner and generation before it acquires, so consumers do not implement a retry race. Releasing an
owner is terminal and repeated calls share one settlement. If several final retirements fail,
`release()` rejects with an `AggregateError` containing only fixed, generation-key-free ownership
errors; failed cleanup remains fenced and charged against `maxGenerations`.

`forceRetire(key)` immediately revokes every current reference and fences every owner that existed
when the force began. An owner created after that boundary may reuse an equal `Map` key only after
the manager retirement fully settles; old retirement work can therefore never overlap its
replacement. A manager-closed result counts as settled because manager shutdown already owns every
runtime generation.

Reversible desired-state transitions stay separate: call `manager.setOffline(key)` without
releasing the owner, then call `manager.ensureOnline(key)` when the host wants that retained
generation online again. Ownership finalization and `forceRetire()` call only `manager.retire()`.
`snapshot()` reports bounded aggregate counts and never emits generation keys or manager failures.

`subscribe(listener)` emits key-free, bounded state transitions. Pass an optional
`McpLifecycleObserver` as `observer` to observe operations performed by each managed
`McpClientRuntime`. Runtime server names are random and never derived from the generation key;
telemetry exporters should omit operation targets when aggregating across dynamic generations.

`callTool(generationKey, name, arguments, options)` accepts either a positional `AbortSignal` or an
`McpRuntimeToolCallOptions` object. Pinning `toolDefinition` keeps the managed client runtime's
structured output validation bound to that exact definition instead of its cached `tools/list`
view, so a host that already holds an approved definition never validates a result against a
drifted schema.

Retained state is bounded by `maxStateEntries` (1,000 by default and always at least
`maxConnections`). Live and quarantined projections are protected; older offline or failed
diagnostics are evicted first. State listeners still receive each bounded transition event even
when its projection cannot be retained.

`MCP_RUNTIME_PHASES` and `MCP_RUNTIME_PROTOCOL_ERAS` publish every lifecycle phase and negotiated
protocol era as frozen tuples for hosts that persist state projections. The matching
`mcpRuntimeStateSnapshotSchema`, `mcpRuntimeProbeSnapshotSchema`, and
`mcpRuntimeCapabilitiesSnapshotSchema` validators implement [Standard
Schema](https://standardschema.dev) v1 with no added runtime dependency: they accept exactly what
the manager emits, reject unknown properties, and return a frozen normalized snapshot.

Cleanup failures quarantine and continue charging the affected generation against the configured
capacity. Runtime cleanup runs before admitted-material cleanup, and both are bounded by
`shutdownTimeoutMs`; a timed-out host `close()` remains quarantined. The manager is in memory only
and implements both `close()` and `AsyncDisposable`.

## Concurrent isolated operations

Use `leaseMode: "concurrent"` with an opaque `admissionKey` for host-authorized independent
operations. Each admitted call creates its own client and closes it before settlement; no online
keeper or shared session is retained. The default `maxConcurrentOperationsPerAdmissionKey` is four;
set it to `null` to use only process capacity. A call's `maxConcurrentOperations` can override this
with a positive integer or `null`. Across related active calls, the strictest supplied ceiling
applies, including calls from older configuration generations.

Opt into `concurrentContention: "queue"` to wait for both connector and process capacity before
allocating a transport. Without this option, saturation returns `MCP_CAPACITY_EXCEEDED` immediately.
One transport ledger charges acquisition, execution, cleanup, and failed cleanup against
`maxConnections`. Waiting neither restarts the operation deadline nor redispatches an operation.

Queued calls rotate fairly across connector keys and remain FIFO within each key. A blocked
connector does not block eligible work for another connector. The queue is bounded by
`maxQueuedOperations` (100 by default). Queue overflow returns `MCP_QUEUE_FULL`; expiry before
admission returns `MCP_ADMISSION_TIMEOUT`. Cancellation removes the waiter immediately. The
optional per-call `onAdmission` observer receives outcome, elapsed admission time, queued count,
and occupied connection count, without keys, credentials, or provider payloads. Observer errors
cannot affect admission. Hosts retain responsibility for authorization and configuration checks
inside the protected operation callback, after admission and before dispatch.

Supply the same stable `admissionKey` to **every isolated operation for that connector**, including
exclusive discovery, probes, OAuth, and tool calls, across actors and configuration generations.
The host owns this identity and the eligibility policy; tool annotations are not authorization.
Keys are bounded to 1–1024 characters and are never emitted in manager diagnostics. Shared/retained
runtimes cannot use keyed admission and must not be mixed into a keyed connector's lifecycle.

An exclusive call with `exclusiveContention: "queue"` waits for related concurrent calls to drain
and blocks new concurrent arrivals until it settles or is cancelled. Waiting remains bounded by
`maxQueuedOperations` and the call deadline. Retirement cancels that generation's calls and waiting
operations, without retiring sibling generations. Uncertain cleanup quarantines its generation
and admission identity until manager replacement, retaining the failed transport's capacity charge.
A successful sibling cleanup cannot clear quarantine.

Limits are local to one manager/process. Hosts operating several processes must allocate their
provider budget across them; this is not a fleet-wide semaphore.

For concurrent runtimes, generation `state()` is the latest lifecycle observation, not an aggregate
connection count. Use `snapshot()` for bounded aggregate pending, active, closing, and quarantined
transport counts. Quarantine is sticky even when a sibling reports another lifecycle transition.
