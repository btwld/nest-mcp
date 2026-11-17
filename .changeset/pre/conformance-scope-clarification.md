---
"@nest-mcp/conformance": minor
---

Scoped the package to what it actually does and dropped the dead CI-regression half. The manifest
description and keywords now state runtime integrity and safety probing for third-party MCP servers
instead of conformance testing, and the README opens by disclaiming any relationship to the official
`@modelcontextprotocol/conformance` spec-compliance suite: this kernel runs bounded, read-only
probes against a server you do not control and supplies the canonicalization, bounded-capture, and
catalog-fingerprinting primitives that detect catalog drift and refuse hostile payloads. It asserts
nothing about the MCP specification.

`compareMcpConformanceReports` and `toMcpConformanceJUnit` are removed with their types
(`McpConformanceReportComparison`, `McpConformanceComparableReportComparison`,
`McpConformanceIncomparableReportComparison`, `McpConformanceComparisonVerdict`,
`McpConformanceCheckChange`), along with the now-unreachable `maxJunitBytes` entry in
`MCP_CONFORMANCE_DEFAULT_LIMITS` and `MCP_CONFORMANCE_HARD_LIMITS`. Baseline-versus-candidate
comparison and JUnit projection belong to a release pipeline, not to a runtime integrity kernel, and
no caller in this repository used either. Plan execution, immutable reports, fingerprints, capture,
catalog digests, and bounded JSON parsing and serialization are unchanged.

`descriptor.subject` keeps its name — the control-plane API response contract and its web client
both read it — and now carries a schema doc comment stating what it records: the build of the
observing client that produced the report, never the observed target, which is `descriptor.target`.
