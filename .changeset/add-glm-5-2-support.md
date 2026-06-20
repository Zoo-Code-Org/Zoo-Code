---
"zoo-code": minor
---

Add GLM-5.2 support with High/Max `reasoning_effort` tiers. The default effort is High (deep reasoning stays opt-in), Max is selected only when the user explicitly picks it, and the parameter is omitted entirely when reasoning is disabled.

Also refines the Opencode Go provider per review: bill MiniMax M3 cache writes (`cacheWritesPrice`), expose the max-output slider for DeepSeek V4 models (`supportsMaxTokens`), wrap pre-stream Anthropic-format errors with the provider prefix, and type the Anthropic streaming path's model info as `ModelInfo` so cost calculation can no longer silently return `$0`.
