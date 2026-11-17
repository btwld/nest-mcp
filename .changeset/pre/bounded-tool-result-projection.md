---
"@nest-mcp/conformance": minor
---

Added a bounded, lossy `tools/call` result projection. Text stays text under per-block and shared
UTF-8 budgets, non-text blocks become descriptor-only summaries, and structured content is rebuilt
as frozen null-prototype JSON under fixed hard ceilings. Hostile or unrepresentable values are
dropped from that enumerable string-key JSON surface without invoking getters and make the immutable
result explicitly `truncated`. Symbol and non-enumerable state is ignored outside the wire surface,
and every retained string is copied so a short projection cannot pin a hostile source string.
