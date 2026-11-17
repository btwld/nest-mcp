---
"@nest-mcp/client": minor
"@nest-mcp/conformance": minor
---

Add bounded OAuth storage snapshot parsers, passive catalog inspection, and exact tool catalog preparation so hosts can consume shared MCP mechanics without reimplementing them.

The client OAuth surface parses authorities, authorization transactions (including authority-digest verification), and bootstrap discovery results as detached immutable values. Parsing performs no network I/O and does not replace host endpoint admission, credential encryption, callback/session binding, expiry, or atomic transaction consumption.

The client provides fresh bounded raw discovery on an already acquired runtime and a per-run inspection target. Conformance provides seven passive discovery checks, ambiguity-first tool selection, exact definition capture, and domain-separated input/output schema identities. The conformance kernel remains independent of the SDK, client, manager, Nest, and product state; the client reuses its existing bounded capture implementation.

Manager refresh retains official SDK aggregation, cache population, and protocol filtering. Passive inspection intentionally inspects raw definitions and does not populate that execution cache.
