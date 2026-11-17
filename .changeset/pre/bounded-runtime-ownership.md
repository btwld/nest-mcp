---
"@nest-mcp/manager": minor
---

Add `McpRuntimeOwnership`, a framework-neutral bounded coordinator for shared opaque runtime
generations. Cooperative final release, force-retirement fencing, manager-retirement barriers,
idempotent owner settlement, manager-close handling, aggregate cleanup failures, and key-free
snapshots and errors let hosts delete projection-ownership bookkeeping without moving durable state
or product policy into the SDK.
