# Contributing

Nest MCP is an ESM-only pnpm workspace targeting Node.js `>=22.13.0`, stable NestJS 12, TypeScript 7, and the official MCP TypeScript SDK v2.

## Set up the workspace

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run build
```

Use the exact pnpm version declared in `package.json`. Do not edit the vendored projects under `references/`; they are research inputs and are excluded from published packages.

## Package boundaries

- `core` must remain free of NestJS and official MCP SDK runtime dependencies.
- `client` imports client-side official SDK surfaces only.
- `manager` owns dynamic generation lifecycle without importing product connection records.
- `conformance` owns bounded plan/report semantics without importing Nest, MCP SDK, client,
  manager, or product code.
- `server` imports server and hosting-adapter surfaces only.
- `apps` owns generic direct-server Apps metadata and capability composition without importing
  NestJS, gateway, browser bridge, or product adapter packages.
- `gateway` may compose client and server packages but must not move routing or token policy into core.
- `nestjs` owns Nest decorators, discovery, DI, and application lifecycle—not protocol behavior.

Avoid dependency cycles. Internal runtime dependencies use `workspace:^`; official SDK and Nest packages exposed through public APIs remain peer dependencies with exact workspace development pins.

## TypeScript and API style

- Use ESM, named exports, explicit package export maps, and `.ts` extensions for relative source imports.
- Use `import type` where imports are type-only.
- Keep strict TypeScript enabled. Do not introduce `any` to bridge an SDK boundary; validate `unknown` or add a typed adapter.
- Prefer discriminated unions and immutable inputs for public runtime contracts.
- Preserve cancellation signals and primary errors across middleware.
- Keep decorated Nest classes in the Nest package so framework-neutral packages stay portable.
- Add an explicit tsdown entry and package export for every public subpath. Do not rely on deep imports.

Public API changes require tests, documentation, and a Changeset. Consumer-visible behavior pins should compare against literal expected values rather than importing the value being tested.

## Tests

```sh
pnpm run test
pnpm run test:coverage
pnpm run verify:pack
pnpm run verify:attw
```

Tests should be deterministic and avoid external services in the default suite. Prefer official in-process transports or a handler-backed `fetch` for client/server integration tests. Close clients before handlers, registries, or Nest applications so in-flight exchanges cannot leak between tests.

Add coverage at the boundary where behavior is observable:

- core middleware order, re-entry, authorization, cancellation, and observer isolation;
- client connection state, discovery freshness, auth retry, and transport ownership;
- server per-request construction, feature registration, resource authentication, and shutdown;
- gateway routing, name collisions, capability projection, and credential separation;
- Nest discovery, module configuration, provider lifecycles, and Express/Fastify mounting.

Any test that needs Postgres, Redis, a broker, or a live identity provider must live in a separately named opt-in suite and fail clearly when its required environment is selected but unavailable.

## Documentation and security

Update the relevant file under `docs/` whenever a change affects state ownership, auth, middleware order, telemetry fields, or deployment assumptions. Never put real tokens, client secrets, internal URLs, or captured MCP payloads in tests or documentation.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.

## Changesets

Add a Changeset for every publishable change:

```sh
pnpm changeset
```

The packages currently release as a fixed alpha group. Choose the smallest semver impact that accurately describes the public change and explain migration requirements in the summary.

## Releasing

Changesets on `main` create or update the release pull request. Merging it publishes through npm
Trusted Publishing (OIDC, with provenance), tags every package, and creates GitHub releases. The
guarded publisher refuses to run outside GitHub Actions on `main`, from a dirty worktree, with a
version set outside the Changesets fixed group, or with a prerelease identifier that disagrees with
`.changeset/pre.json`.

### One-time npm bootstrap

npm only lets maintainers configure a trusted publisher after a package exists. Bootstrap the first
prerelease interactively from a clean, fully verified checkout. Publish in dependency order and
always use the alpha dist-tag:

```sh
pnpm run verify
for PKG in core client manager conformance server apps observability auth gateway nestjs; do
  (cd "packages/$PKG" && pnpm publish --access public --tag alpha --provenance=false)
done
```

Use pnpm here because it rewrites internal `workspace:^` ranges in the published manifests. Complete
npm's browser or two-factor flow locally; never add an npm token to this repository. Then bind each
package to the routine release workflow:

```sh
for PKG in @nest-mcp/core @nest-mcp/client @nest-mcp/manager @nest-mcp/conformance @nest-mcp/server @nest-mcp/apps @nest-mcp/auth @nest-mcp/observability @nest-mcp/gateway @nest-mcp/nestjs; do
  npm trust github "$PKG" \
    --file release.yml \
    --repository btwld/nest-mcp \
    --environment release \
    --allow-publish \
    --yes
done
```

After this bootstrap, all publication must use the GitHub release workflow. Once prerelease mode is
exited, publishing falls back to Changesets' stable-release behavior automatically.

## Pull requests

Before requesting review:

1. Run `pnpm run check` and `pnpm run test`.
2. Run `pnpm run verify:pack` for export-map and packed-package validation.
3. Add or update a Changeset.
4. Update documentation and examples.
5. Confirm generated output, coverage, local environment files, and vendored references are not included.
