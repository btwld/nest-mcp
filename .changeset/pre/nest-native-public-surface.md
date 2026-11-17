---
"@nest-mcp/client": minor
"@nest-mcp/server": minor
"@nest-mcp/gateway": minor
"@nest-mcp/nestjs": minor
---

Narrow the Nest integration to a Nest-native public surface and remove redundant construction
aliases across the lower runtimes.

`@nest-mcp/nestjs` now exports its module, decorators, application services, Nest configuration types,
and a deliberately small set of callback helpers instead of mirroring every core, client, server,
gateway, and observability export. Import framework-neutral APIs from their owning packages.
`McpModule` is local by default, ordinary Nest modules replace `forFeature()`, low-level server
registration uses injectable contributors, server collaborators are configured through provider
tokens, catalog and gateway policies are singleton Nest providers, and internal registries/options
tokens are no longer public application services. A second configured root fails bootstrap; put all
clients and servers in the application's single shared root. Use `McpCapabilitiesService` for supported live
capability registration. Collaborators are explicitly registered under `McpModule` so Nest module
isolation and lifecycle ordering are preserved.

Remove the no-op `defineMcpServer`, `defineMcpServerFeature`, and
`defineMcpCatalogExposureResolver` helpers; use contextual typing or `satisfies` instead. Remove
the redundant `createMcpGateway`, `createMcpGatewayFeature`, and
`createDefaultMcpClientTransportFactory` factories; construct `McpGateway` directly and use the
shared default client transport factory. Remove `withMcpBearerAuth` and
`withMcpRequestValidation`; construct `McpResourceServer` and `McpValidatedServer` directly.
