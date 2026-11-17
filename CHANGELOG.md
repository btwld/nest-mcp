# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow Semantic Versioning after accounting for the additional instability of alpha versions.

## [Unreleased]

### Added

- Initial pnpm monorepo and fixed-group Changesets release configuration.
- Framework-neutral operation middleware, fail-closed authorization, and lifecycle observation in `@nest-mcp/core`.
- Multi-server official v2 client runtime with typed general requests, manual modern `input_required` rounds, completion, managed modern subscriptions, and explicit legacy subscription delegates in `@nest-mcp/client`.
- Stateless per-request server runtime and OAuth resource-server composition in `@nest-mcp/server`.
- Policy-enforced tool, prompt, concrete-resource, resource-template, and completion aggregation with reversible routing, authorization-scoped discovery caching, and first-party client-runtime composition in `@nest-mcp/gateway`.
- Backend-neutral bounded logging, metrics, tracing, attribute projection, and redaction adapters in `@nest-mcp/observability`.
- NestJS 12 module, decorator discovery, named multi-server client integration, and application lifecycle in `@nest-mcp/nestjs`.
- First-class Nest aggregate gateway definitions backed by module-owned named clients, with bootstrap-time reference validation, operational lookup, dependency-ordered shutdown, and lifecycle-safe cleanup error reporting.
- Validated Nest handler authorization, middleware, and lifecycle pipelines shared by decorated HTTP and stdio callbacks.
- Async injected Nest module configuration, local-module mode, and rollback of partially initialized runtimes after bootstrap failure.
- Architecture, security/OAuth, observability, contribution, and repository security documentation.
- Node 22/24 CI for checks, tests, builds, and package publication validation.
- Authorization-safe eager, search, and lazy Nest tool catalog exposure over per-request visible
  snapshots, including bounded discovery meta-tools and live-registry compatibility.
- Method- and operation-specific typed transform helpers for client and gateway middleware.

### Changed

- Renamed Nest capability decorators to `Tool`, `Prompt`, `Resource`, and `Targets`, with matching unprefixed option and decorator types. Module and runtime names remain MCP-qualified.

### Planned

- Vendor-specific OpenTelemetry bindings, distributed event-bus and cache implementations, and external policy-engine adapters.

## [2.0.0-alpha.0] - Unreleased

Initial 2.x alpha. This version has not been declared stable and may receive breaking API changes before publication.
