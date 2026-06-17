---
"zoo-code": patch
---

Forward the active task ID to the LiteLLM proxy as an `X-Zoo-Session-ID` request header so individual conversations can be correlated in LiteLLM logs and spend tracking. The header is only sent when a task ID is present, and follows the `x-<vendor>-session-id` convention used by Claude Code (`x-claude-code-session-id`) and GitHub Copilot (`x-copilot-session-id`).
