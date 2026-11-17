---
"@nest-mcp/manager": minor
---

Add an explicit exclusive operation lease mode for non-pooled, close-before-settlement managed MCP
runtimes, including same-generation conflict fencing and retirement coverage. Shared catalog refresh
now waits for every parallel discovery request before releasing its lease, while exclusive refresh
serializes those requests for minimal OAuth providers. The public docs identify `refreshCatalog`
plus `digestMcpRuntimeCatalog` as the generic freshness/change boundary.
