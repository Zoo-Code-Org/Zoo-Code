---
"zoo-code": patch
---

Make fallback context truncation recovery monotonic instead of reporting zero-progress successes (#1254).

For short histories (e.g. an assistant `tool_use` followed by one oversized user `tool_result`), the fraction-based message calculation rounded down to zero removable messages, but `manageContext` still returned a success-shaped truncation result: a fresh `truncationId` with `messagesRemoved: 0` and an unchanged history. The task then emitted a "context truncated" event while the oversized history stayed as-is, and every subsequent request retried into the same over-budget failure indefinitely.

Zero-progress rounds now degrade in place: the largest eligible textual `tool_result` blocks are shrunk (keeping their `tool_use_id` and block shape, so the `tool_use`/`tool_result` pair is never orphaned), and recovery only reports success when the recalculated model-facing token count actually decreases. When protected content leaves nothing to remove or shrink, `manageContext` returns a controlled `error`/`errorDetails` result instead of emitting another fake truncation event.
