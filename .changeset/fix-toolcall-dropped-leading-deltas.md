---
"zoo-code": patch
---

Fix streaming tool-call arguments being dropped when argument deltas arrive before the tool-call id, which caused spurious "missing required parameter" errors (affects LiteLLM, OpenAI-compatible, and DeepSeek providers).
