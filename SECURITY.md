# Security policy

Nest MCP sits between agents and executable capabilities. Treat its configuration, credentials, server registry, and policy hooks as security-sensitive infrastructure.

## Supported versions

During the alpha, only the latest `2.0.0-alpha.*` release receives security fixes. Older alpha builds and source snapshots are unsupported. This policy will be revised before a stable release.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/btwld/nest-mcp/security/advisories/new). Do not open a public issue, discussion, or pull request containing exploit details, credentials, access tokens, private server URLs, or customer data.

Include, when possible:

- affected package and version;
- deployment shape and transport;
- minimal reproduction or proof of concept;
- expected and observed authorization boundary;
- impact and required attacker access; and
- any temporary mitigation already applied.

Maintainers will acknowledge the report through the private advisory, investigate across every affected package, coordinate a fix and disclosure, and credit the reporter if requested. Please allow time for a coordinated release before publishing details.

## Security boundaries

- OAuth authentication does not replace application authorization. A valid bearer token identifies a caller; a policy must still authorize that caller for the requested server, capability, resource, or tool.
- An MCP session identifier is routing metadata, not an authentication credential.
- A gateway plays both roles: it is a resource server to downstream callers and an OAuth client to upstream servers. Incoming bearer tokens must not be forwarded upstream by default.
- Stdio transport can execute a local process. Server command, arguments, working directory, and environment must come from trusted configuration.
- An HTTP MCP server URL is an outbound network destination. Production registries should use explicit allowlists and protect against DNS rebinding and private-network SSRF.
- Tool descriptions and tool results are untrusted content. They can contain prompt injection even when the server itself is authenticated.

Operational guidance is maintained in [Security and OAuth](docs/security-and-oauth.md).
