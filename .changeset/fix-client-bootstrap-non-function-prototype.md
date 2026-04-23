---
'@nest-mcp/client': patch
---

Fix `McpClientBootstrap.wireNotificationHandlers` crashing with `TypeError` when a sibling provider's prototype exposes non-function own properties (e.g. `useValue: {}` providers, whose prototype `Object.prototype.__proto__` resolves to `null`). The notification scan now skips prototype entries whose value is not a function before calling `Reflect.getMetadata`. Fixes #18.
