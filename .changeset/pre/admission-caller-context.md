---
"@nest-mcp/manager": patch
---

Preserve the waiting caller's async context when a different caller releases capacity and wakes transport allocation. Tenant context and request-local diagnostics remain attached to the admitted caller.
