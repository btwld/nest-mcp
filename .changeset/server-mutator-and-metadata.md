---
'@nest-mcp/common': minor
'@nest-mcp/server': minor
---

feat(common,server): add `serverMutator`, `title`, `websiteUrl`, and `icons` to `McpModuleOptions`

- `serverMutator?: (server) => server` lets you reach into the underlying SDK
  `McpServer` after our factory builds it (e.g., to register custom JSON-RPC
  methods that the public API does not expose).
- `title`, `websiteUrl`, and `icons` are forwarded to the SDK
  `Implementation` block alongside `name`, `version`, and the existing
  `description`, so clients can display richer server metadata in the
  `initialize` response.
