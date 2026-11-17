---
"@nest-mcp/client": patch
---

Enforce the RFC 6749 ASCII NQCHAR grammar for configured, discovered, registered, and returned
OAuth scope tokens, while preserving valid punctuation such as commas. Token exchange now retains
the pinned requested scope when the response omits it; refresh can retain a caller-supplied current
scope, and both flows reject an explicit scope that widens the bound grant.
