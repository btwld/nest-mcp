---
"@nest-mcp/client": minor
---

Add passive MCP authentication detection over host-admitted fetch. Validate anonymous modern discovery or a complete legacy handshake through the official SDK, or require validated OAuth bootstrap evidence after an authorization denial. Keep unsupported authentication, unreachable endpoints, invalid responses, and failed metadata discovery indeterminate. Bound streaming response reads, deadlines, and legacy session cleanup without performing registration, token acquisition, or feature invocation.

Hosts may supply a separate guarded OAuth metadata fetch while retaining endpoint-only admission for MCP traffic. Existing challenge probing and OAuth enrollment APIs are unchanged.
