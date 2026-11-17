---
"@nest-mcp/client": minor
---

Add a bounded, framework-neutral `McpClientLeaseManager` for opaque, non-secret identity keys. It
deduplicates concurrent resource creation, maintains active reference counts, drains retired
generations safely, supports explicit idle reuse, and defaults every resource to close on final
release.
