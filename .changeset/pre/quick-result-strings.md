---
"@nest-mcp/conformance": patch
---

Use bounded native byte counting and detached UTF-16 copies for fitted MCP result strings. Preserve Unicode, lone surrogates, truncation budgets, and all result validation; avoid character-by-character rebuilding of large accepted results. No API changes.
