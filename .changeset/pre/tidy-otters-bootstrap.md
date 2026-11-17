---
"@nest-mcp/client": minor
---

Add a host-managed OAuth bootstrap that parses bounded Bearer challenges, discovers
protected-resource and authorization-server metadata, returns explicit issuer-selection and
strict-compatibility results, honors challenged scope priority, and exposes CIMD and legacy DCR
capabilities without performing registration. Add an explicit dynamic-registration compatibility
subpath that performs one policy-approved public-client registration POST without retries or host
state.
