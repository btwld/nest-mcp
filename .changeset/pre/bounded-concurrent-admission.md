---
"@nest-mcp/client": patch
"@nest-mcp/manager": patch
"@nest-mcp/nestjs": patch
---

Add opt-in bounded concurrent admission across process and connector capacity, nullable connector ceilings, fair FIFO scheduling across connector keys, and distinct queue-full and admission-timeout diagnostics. Reserve transports against the existing lease ledger and retain charges through cleanup; cancellation, retirement, and shutdown remove queued work without redispatch. Expose key-free admission timing and capacity notifications.
