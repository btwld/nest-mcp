---
"@nest-mcp/client": patch
---

Preserve optional MCP tool fields by explicitly disabling provider strict-schema normalization in the AI SDK adapter. This prevents Responses API calls from requiring optional or mutually exclusive query options. Inputs and protected execution validation remain unchanged; consumers require no code changes.
