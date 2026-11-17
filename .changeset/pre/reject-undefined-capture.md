---
"@nest-mcp/conformance": minor
---

Add a behavioral options argument to `captureMcpConformanceValue` and `captureMcpToolArguments`.
`undefinedPolicy: "reject"` now refuses undefined values at any depth, while the default `"json"`
policy preserves the existing object-omission and array-to-null behavior.
