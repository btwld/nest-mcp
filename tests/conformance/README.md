# @nest-mcp/conformance-harness

Private workspace package. Never published, never released, no Changeset.

It runs the **official** [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)
suite — the spec-compliance harness maintained by the MCP working group — against an
"everything server" built on `@nest-mcp/server`, mirroring how the official TypeScript SDK
dogfoods the same suite.

This is not the same thing as the published `@nest-mcp/conformance` package. That one is a
runtime adversarial-integrity toolkit for inspecting _third-party_ MCP servers (canonicalization,
fingerprinting, bounded capture, catalog digests, safe-discovery probes). This harness answers a
different question: does our own server runtime speak the protocol the specification describes?

## Layout

| Path                       | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `src/everything-server.ts` | The fixture: tools, resources, resource templates, and prompts the suite requires. |
| `src/http-fixture.ts`      | Serves the fixture over `node:http` on loopback, on an ephemeral port.             |
| `src/start.ts`             | Standalone start script (`PORT` pins a port; otherwise ephemeral).                 |
| `src/run.ts`               | Starts the fixture, then shells out to the official CLI in server mode.            |
| `expected-failures.yaml`   | The baseline of scenarios that are known to fail today.                            |

```sh
pnpm --filter @nest-mcp/conformance-harness run conformance
pnpm --filter @nest-mcp/conformance-harness run conformance -- --scenario tools-call-error --verbose
pnpm --filter @nest-mcp/conformance-harness run start   # serve the fixture only
```

The fixture imports `@nest-mcp/server` through its published export map, so the workspace
packages must be built first (`pnpm run build`).

## Fixture contract

Most `test_*` names in `src/everything-server.ts` are dictated by the suite, not chosen by us:
each scenario asserts a specific tool, resource, or prompt exists and returns a specific payload.
When a scenario fails, the CLI prints the exact contract it expected — that output is the
authoritative reference. Names prefixed `nest_mcp_` are ours, and cover `@nest-mcp/server` surface
no active scenario reaches yet (structured tool output).

## Version pinning policy

`@modelcontextprotocol/conformance` is pinned to an **exact** version, with no caret. The suite is
pre-1.0 and adds scenarios in patch releases, so a floating range would turn an upstream release
into a surprise CI failure on an unrelated pull request.

Upgrading is a deliberate, reviewed event:

1. Bump the exact version in `package.json` and run `pnpm install`.
2. Run the harness and read the diff in scenario results.
3. Add newly failing scenarios to `expected-failures.yaml` **with a comment explaining the gap**,
   or fix `@nest-mcp/server` — but never silently.
4. Remove entries for scenarios the new version now passes.

## Expected-failures philosophy

The baseline exists to make regressions visible, not to hide failures. Its contract, enforced by
the CLI's exit code:

| Scenario result | In baseline | Outcome                         |
| --------------- | ----------- | ------------------------------- |
| Fails           | yes         | exit 0 — known gap              |
| Fails           | no          | exit 1 — regression             |
| Passes          | yes         | exit 1 — stale entry, delete it |
| Passes          | no          | exit 0                          |

A stale entry failing the build is the point: when a gap closes, the baseline shrinks in the same
change. Two rules follow from that:

- Every entry carries a comment naming the real cause.
- A fixture bug is never baselined. If the fixture is what is broken, fix the fixture.

## Known limitation: HTTP only

The official suite has no stdio harness — `conformance server` takes a `--url` and speaks
Streamable HTTP. `@nest-mcp/server` also serves stdio through `McpServerRuntime.serveStdio()`,
and that path is covered only by this repository's own unit and integration tests. Treat a green
run here as evidence about the HTTP transport and the shared protocol layer, not about stdio
framing.

The suite's client is built on the v1 MCP SDK, so it negotiates a 2025-era protocol revision and
exercises `createMcpHandler`'s legacy stateless serving rather than the 2026-07-28 modern path.
Several baseline entries follow directly from that; see `expected-failures.yaml`.
