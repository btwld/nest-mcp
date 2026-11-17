---
"@nest-mcp/manager": minor
---

Add immediate bounded admission for concurrent isolated operations keyed by a host-owned connector identity. Preserve exclusive ordering across generations, cancellation, close-before-settlement, and quarantine after uncertain cleanup. Hosts must supply the same admission key to all isolated operations for a connector and explicitly authorize independent concurrency.
