---
"zoo-code": patch
---

Surface upstream errors that arrive mid-stream from the Zoo and Vercel AI gateways. Provider failures such as rate limits are sent as an in-band error chunk once the response is already streaming, so the extension previously showed a generic "no response" instead of the real reason. Both handlers now detect these chunks and surface the upstream message (and, for the Zoo gateway, the existing sign-in / add-credits / budget prompts).
