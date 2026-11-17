---
"@nest-mcp/server": patch
---

Admit tool-defined `Mcp-Param-*` request headers in the CORS preflight, so browser clients can
mirror annotated tool parameters into headers without the host listing each one.
