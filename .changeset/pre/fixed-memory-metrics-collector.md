---
"@nest-mcp/observability": minor
---

Add `McpFixedMemoryMetricsCollector`, a framework-neutral synchronous sink for the canonical batches
emitted by `createMcpMetricsObserver`. It exposes immutable process snapshots, a fixed rolling
window and duration histogram, bounded operation grouping, strict atomic batch parsing, and a
fixed-label Prometheus representation without retaining identifiers, payloads, targets, or errors.
