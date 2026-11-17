---
"@nest-mcp/manager": minor
"@nest-mcp/client": minor
---

Add opt-in bounded FIFO admission for exclusive operations with `exclusiveContention: "queue"`.
Concurrent callers each acquire fresh admitted transport material after prior cleanup, while the
existing exclusive default remains fail-fast. Queue waiting shares the request deadline, respects
caller cancellation, and is fenced by retirement, shutdown, and cleanup quarantine. Expose a global
`maxQueuedOperations` bound and key-free queue diagnostics.

Add `awaitCleanupOnCancel` to client lease acquisition. Exclusive manager operations select it so
cancellation during acquisition drains their abandoned material before a queued operation starts;
ordinary client acquisitions retain immediate, caller-local cancellation by default.
