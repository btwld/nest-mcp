---
"@nest-mcp/client": patch
---

Add an optional exact credential revision to the minimal OAuth auth provider. Pinned operations fail closed after rotation, and delayed concurrent authentication failures cannot refresh or adopt a replacement credential. Existing unpinned providers retain their binding-following behavior.
