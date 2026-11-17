---
"@nest-mcp/client": patch
---

Accept OAuth authorization servers that do not advertise RFC 9207 response issuer support. The
callback still requires an exact `iss` when support is advertised and rejects every mismatched
`iss` value when one is returned.
