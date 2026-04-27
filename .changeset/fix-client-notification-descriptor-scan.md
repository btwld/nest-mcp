---
"@nest-mcp/client": patch
---

Avoid invoking provider prototype accessors while wiring `@OnMcpNotification` handlers. The bootstrap scanner now inspects property descriptors and only reads method values, preventing Nest provider getters from throwing during app startup.
