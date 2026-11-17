# `@nest-mcp/conformance`

> **This is not the official MCP conformance suite.** For MCP _specification_ compliance testing,
> use [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance).
> This package instead runs bounded, read-only safety and integrity probes against third-party MCP
> servers at runtime, and provides the canonicalization, bounded-capture, and catalog-fingerprinting
> primitives used to detect catalog drift and refuse hostile payloads. It contains no spec
> assertions.

A framework-neutral orchestration and report kernel for repeatable runtime integrity probes against
an MCP server you do not control.

The package executes a host-defined, ordered plan against an ephemeral target and produces a
bounded immutable report. It deliberately does not own transports, endpoints, credentials,
connections, persistence, baseline approval, or dashboard policy. Those stay in the host that
already owns the MCP runtime generation.

## Install

```sh
pnpm add @nest-mcp/conformance
```

## Define and run a plan

```ts
import { defineMcpConformancePlan, runMcpConformancePlan } from "@nest-mcp/conformance";

interface Target {
	ping(signal: AbortSignal): Promise<void>;
}

declare const target: Target;

const plan = defineMcpConformancePlan<Target>({
	id: "safe-discovery",
	version: "1",
	title: "Safe discovery",
	checks: [
		{
			id: "protocol.ping",
			title: "Protocol ping",
			risk: "read-only",
			async run({ target, signal }) {
				await target.ping(signal);
				return { status: "pass", code: "PING_OK" };
			},
		},
	],
});

const report = await runMcpConformancePlan(plan, {
	target,
	runId: crypto.randomUUID(),
	descriptor: {
		target: { kind: "connection", id: "fixture-a", revision: 3, generation: 2 },
		subject: { name: "@nest-mcp/nestjs", version: "2.0.0-alpha.0" },
	},
});
```

Checks run one at a time. Side-effecting checks are skipped unless `allowSideEffects: true` is
explicitly set. Caller cancellation and bounded run/check timeouts are propagated through the
check signal. A check may return `error` with a stable infrastructure code; otherwise thrown errors
are converted to `CHECK_THREW`. Error messages, stacks, inputs, and outputs never enter the report.
Observer callbacks are best-effort notifications: returned promises are deliberately not awaited,
so telemetry cannot delay checks or defeat run bounds.

The target adapter must propagate each check's `signal` into its underlying network, runtime, and
lease operations. A timeout bounds how long the runner waits; it cannot forcibly stop work that
ignores cancellation. Hosts should compose the check signal with generation-retirement and shutdown
signals, make adapter cleanup idempotent, and release the underlying lease only after cooperative
work has settled.

`descriptor.subject` records the build of the observing client that produced the report, not the
server under test; the observed server is `descriptor.target`.

## Serialize a report

```ts
import {
	parseMcpConformanceReportJson,
	serializeMcpConformanceReport,
} from "@nest-mcp/conformance";

const json = serializeMcpConformanceReport(report);
const parsed = parseMcpConformanceReportJson(json);
```

JSON parsing, runner output, and serialization use a 1 MiB default report limit. Trusted hosts that
need a larger report may set `limits.maxJsonBytes` on the runner and pass
`{ maximumBytes: value }` to JSON parsing or serialization, up to the 4 MiB hard limit. Fingerprint
inputs are capped at 8 MiB, 128 levels, and 100,000 JSON nodes before canonical sorting.

## Capture untrusted values and digest a catalog

`canonicalizeMcpConformanceValue` enforces only its own fixed ceilings (8 MiB, 128 levels, 100,000
nodes, 50,000 properties per object) and walks a hostile shape on the way there.
`captureMcpConformanceValue` refuses the shape instead. It copies an untrusted value into
deep-frozen, null-prototype JSON data under caller-supplied bounds, rejecting proxies, accessor and
non-enumerable properties, symbol keys, sparse or subclassed arrays, exotic prototypes, cycles, and
non-finite numbers. `undefined` follows the canonicalizer's own JSON semantics by default, so a
captured value always canonicalizes exactly like its source. Pass `{ undefinedPolicy: "reject" }` as
the third argument when omission from objects or conversion to `null` in arrays must be refused.

```ts
import {
	captureMcpConformanceValue,
	captureMcpToolArguments,
	digestMcpRuntimeCatalog,
	toMcpConformanceFingerprintHex,
	type McpConformanceCatalogSnapshot,
} from "@nest-mcp/conformance";

declare const untrusted: unknown;
declare const catalog: McpConformanceCatalogSnapshot;

const limits = {
	maxBytes: 262_144,
	maxDepth: 24,
	maxProperties: 8_192,
	maxStringBytes: 32_768,
	maxItems: 512,
};

const value = captureMcpConformanceValue(untrusted, limits);
const arguments_ = captureMcpToolArguments(untrusted, limits);
const strictArguments = captureMcpToolArguments(untrusted, limits, {
	undefinedPolicy: "reject",
});

const digest = digestMcpRuntimeCatalog(catalog, {
	domain: "acme/mcp/catalog/v1",
	toolSchemaDomain: "acme/mcp/tool-schema/v1",
	limits,
});
const hexadecimal = toMcpConformanceFingerprintHex(digest.catalogFingerprint);
```

Bounds are resolved against `MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS` and
`MCP_CONFORMANCE_HARD_CAPTURE_LIMITS` by `resolveMcpConformanceCaptureLimits`. A refusal is an
`McpConformanceCaptureError` whose `code` states the structural reason; messages never quote the
rejected value, its keys, or the limit that was reached.

`captureMcpToolArguments` layers a `Readonly<Record<string, unknown>>` argument record on the same
capture. Both capture functions accept `McpConformanceCaptureOptions` as their third argument;
`undefinedPolicy` is `"json"` by default and may be set to `"reject"` to refuse an `undefined` value
at any depth. Byte accounting is predictive — every node spends exactly the canonical JSON bytes it
will later serialize to, so an oversized payload is refused before it is materialized — and the
prediction is then cross-checked against `canonicalizeMcpConformanceValue`'s exact output byte
length. A fence that failed to hold rejects the arguments instead of passing them on.

`digestMcpRuntimeCatalog` accepts a catalog structurally, by its `tools`, `resources`,
`resourceTemplates`, and `prompts` collections, so a runtime manager's catalog snapshot satisfies it
without this kernel depending on a runtime package. It returns one `catalogFingerprint` plus a
per-tool `schemaDigest`, letting a management path and a serving path compare the same surface.
Both domains are caller-supplied and validated with the fingerprint domain rule. Discovery order
never reaches a digest: each collection is sorted on its identity (`name`, `uri`, or `uriTemplate`)
with a canonical-form tiebreak, and a repeated identity is refused rather than silently collapsed.

For a live managed generation, `McpRuntimeManager.refreshCatalog()` is the freshness owner: it forces
the client list caches to refresh, bounds discovery, waits for the complete list wave, and returns a
timestamped frozen snapshot. Pass that snapshot directly here. When the transport is
credential-bound and has no request-correlated refresh fence, select the manager's
`{ leaseMode: "exclusive" }` so the freshness wave is sequential and also owns a non-pooled
close-on-release runtime. This package still owns only the canonical comparison; refresh scheduling,
baseline persistence, and reactions to change remain host policy.

Fingerprints keep the package's `sha256:<base64url>` form. `toMcpConformanceFingerprintHex` renders
one as 64 lowercase hexadecimal characters, so a digest column with a fixed-width hexadecimal
`CHECK` can store it without hand-rolled transcoding.

## Project an untrusted tool result

`projectMcpToolResult` is the lossy output boundary for a `tools/call` result. Text blocks remain
bounded text; image, audio, embedded-resource, resource-link, unknown, and future blocks become
descriptor-only summaries. Their data, URIs, and other fields are never copied. Structured content
is rebuilt as frozen null-prototype JSON under depth, node, string, and serialized-byte limits.
Fitted strings use bounded native byte counting and detached UTF-16 copies, preserving lone
surrogates without retaining source-string backing storage. Oversized strings scan only their
bounded retained prefix.
Every omitted, malformed, hostile, or truncated value in MCP's enumerable string-key JSON surface
sets the result's `truncated` flag. Symbol and non-enumerable state is outside that wire surface and
is ignored without explicit enumeration. Emitted data and per-value string scans are bounded, but
JavaScript object-key enumeration can still cost O(source properties); production callers must cap
the transport response body before parsing as well as applying this post-parse projection.

```ts
import { projectMcpToolResult } from "@nest-mcp/conformance";

declare const untrustedToolResult: unknown;

const projected = projectMcpToolResult(untrustedToolResult, {
	maxContentBlocks: 20,
	maxTextBytesPerBlock: 8_192,
	maxTextBytesTotal: 65_536,
	maxStructuredDepth: 8,
	maxStructuredNodes: 1_000,
	maxStructuredStringBytes: 16_384,
	maxStructuredSerializedBytes: 65_536,
	maxSummaryDescriptorLength: 128,
});
```

Omit the limits to use the same conservative defaults shown above. Fixed hard ceilings still apply
to caller overrides. Proxies, accessors, exotic prototypes, cycles, sparse entries, symbol keys,
non-finite numbers, and `__proto__` members are dropped without invoking source getters.
`degradedMcpToolResult` supplies an immutable empty fallback when a host deliberately catches a
projection failure at a wider boundary.

## Safety boundary

Facts are restricted to bounded scalar values. Sensitive-looking fact keys are omitted, strings
are truncated, and caught exception details are never serialized. A host should still author plans
as trusted code and must not deserialize executable checks or accept arbitrary operations from a
dashboard request.

## Passive discovery and exact tool preparation

`createMcpPassiveDiscoveryPlan({ catalogDomain, toolSchemaDomain })` supplies seven read-only checks:
connection state, protocol negotiation, ping, bounded discovery, duplicate identities, input/output
schema compilation, and catalog identity. Optional `id`, `version`, and `title` let the host name
its fixed plan. Schema inspection stops after 256 schemas and bounds each schema before compiling.
The structural target owns `snapshot`, `ping`, `catalog`, and `schemaCompiles`; this package never
imports a transport, client, manager, or SDK. `@nest-mcp/client` provides an adapter for an already
acquired runtime. Hosts still own access policy, leases, report persistence, and display.

```ts
import {
	selectMcpCatalogTools,
	selectMcpCatalogTool,
	captureMcpToolDefinition,
	digestMcpToolSchemas,
} from "@nest-mcp/conformance";

const selection = selectMcpCatalogTools({ tools: catalog.tools }, { limits });
const exact = selectMcpCatalogTool({ tools: catalog.tools }, "search", { limits });
// exact.status is "selected", "missing", or "ambiguous".
const definition = captureMcpToolDefinition(tool, definitionLimits);
const schemaIdentity = digestMcpToolSchemas(selectedDefinitions, {
	domain: "example/tool-schemas/v1",
	limits,
});
```

Selection captures bounded immutable definitions, sorts supported names deterministically, and
excludes every definition sharing an ambiguous name **before** host usage filters. Empty names
and names over 256 code units are unsupported; `maxNameLength` can tighten that ceiling.
`definitionLimits` optionally tightens each definition within the collection's `limits` budget.
Capture preserves typed protocol extensions and rejects over-budget definitions instead of
truncating schemas. Callers supply already typed protocol definitions; this is not an SDK wire
schema parser. The schema digest includes names and both complete input and output schemas,
ignores catalog order and display metadata, and rejects ambiguous names. Its canonical envelope
is `{ schemas, version: 2 }`, with absent output schemas represented as `null`.

Connection identity, task/usage support, approval, workspace inheritance, and artifact binding
remain host decisions. Apply those policies after exact catalog identity selection.

### Browser report consumers

Import `McpConformanceReportSchema`, `McpConformanceReport`, and the existing JSON helpers from `@nest-mcp/conformance/report` to validate and display reports without loading discovery, runner, or Node modules. The subpath depends only on Zod and standard browser APIs, and enforces the same byte limits and report consistency as the server entry point.
