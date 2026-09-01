---
"zoo-code": patch
---

Fix `_isGrokXAI()` false-positive substring match that broke token usage for OpenAI-compatible providers whose domain contains "x.ai" as a substring (e.g. box.ai, fox.ai, max.ai).

The `_isGrokXAI()` method in `src/api/providers/openai.ts` used `urlHost.includes("x.ai")` which is a substring match. Any domain containing "x.ai" anywhere in its host (e.g. `box.ai`, `fox.ai`, `max.ai`) was falsely identified as a Grok/xAI endpoint. This caused `stream_options: { include_usage: true }` to be omitted from API requests in both `createMessage()` and `handleO3FamilyMessage()`, so the API never returned usage data and the token bar showed 0 — a silent failure with no error message.

Fixed by using exact host match (`api.x.ai`) or subdomain suffix check (`.x.ai`) instead of substring `includes()`.
