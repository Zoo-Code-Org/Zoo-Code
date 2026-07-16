---
"zoo-code": patch
---

Fix Anthropic provider silently replacing a custom/unrecognized `apiModelId` with the hardcoded default model.

`AnthropicHandler.getModel()` coerced any `apiModelId` not present in the static `anthropicModels` table down to `anthropicDefaultModelId` ("claude-sonnet-4-5"), and that coerced id was what actually got sent as `model` in the API request -- silently ignoring a user-configured custom model name (e.g. a custom Anthropic-compatible deployment or proxy). This produced confusing "model does not exist" errors for the default model instead of the model the user actually selected (#418).

The same fallback also affected capability lookups used to build the `thinking` request parameter: an unrecognized id fell back to the default model's info, which can be from an older model generation with a different API contract, causing the request to use the legacy `thinking: {type: "enabled", budget_tokens}` shape and get rejected with a 400 by models that require `{type: "adaptive"}`.

The model id sent to the API now always honors a user-configured `apiModelId`. For unrecognized values, capabilities are best-effort guessed by matching known model-family substrings (mirroring the existing `BedrockHandler.guessModelInfoFromId` heuristic) instead of defaulting to `anthropicDefaultModelId`'s info.
