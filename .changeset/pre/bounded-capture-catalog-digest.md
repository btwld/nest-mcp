---
"@nest-mcp/conformance": minor
---

Added bounded hostile-value capture and canonical catalog digests, so hosts stop hand-rolling both
around the canonicalizer. `canonicalizeMcpConformanceValue` enforces only its own fixed ceilings and
walks a hostile shape on the way there; `captureMcpConformanceValue(value, limits)` refuses the
shape instead, copying an untrusted value into deep-frozen, null-prototype JSON data under
caller-supplied bounds and rejecting proxies, accessor and non-enumerable properties, symbol keys,
sparse or subclassed arrays, exotic prototypes, cycles, and non-finite numbers.
`captureMcpToolArguments` layers a bounded argument record on it with predictive byte accounting
that is cross-checked against the canonicalizer's exact output byte length. Bounds resolve through
`resolveMcpConformanceCaptureLimits` against `MCP_CONFORMANCE_DEFAULT_CAPTURE_LIMITS` and
`MCP_CONFORMANCE_HARD_CAPTURE_LIMITS`, and a refusal is an `McpConformanceCaptureError` carrying a
structural `code` that never quotes the rejected value.

`digestMcpRuntimeCatalog(snapshot, { domain, toolSchemaDomain, limits })` returns one
`catalogFingerprint` plus a per-tool `schemaDigest` so a management path and a serving path can
compare the same surface. The snapshot is typed structurally by its `tools`, `resources`,
`resourceTemplates`, and `prompts` collections, keeping the kernel free of a runtime dependency.
Discovery order never reaches a digest — each collection sorts on its identity with a canonical-form
tiebreak — and a repeated identity is refused rather than silently collapsed. `fingerprintMcpConformanceValue`'s
domain rule now also validates both caller-supplied digest domains, and the new
`toMcpConformanceFingerprintHex` renders a `sha256:<base64url>` fingerprint as 64 lowercase
hexadecimal characters for digest columns that check a fixed-width hexadecimal form.
