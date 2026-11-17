---
"@nest-mcp/nestjs": patch
---

Declare `@nest-mcp/auth` as a runtime dependency so production installs can import the built Nest
module's OAuth integration without relying on development dependencies. Add a first-class
`@nest-mcp/nestjs/client` entrypoint for outbound-only Nest applications without loading inbound server,
gateway, or OAuth implementation code.
