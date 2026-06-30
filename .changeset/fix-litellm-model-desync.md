---
"zoo-code": patch
---

Fix LiteLLM provider cache key collision, credential priority, and model-selection fallback to non-existent default.

Two bugs are addressed:

1. **Cache key collision**: All URL-scoped providers (LiteLLM, Ollama, LM Studio, Poe, DeepSeek,
   Requesty) previously shared one cache entry keyed only on the provider name. Switching between
   profiles backed by different servers silently served the wrong model list and the stale list
   persisted across VS Code restarts via the disk cache. Fixed with a compound cache key:
   URL-scoped providers use `provider:baseUrl`; key-scoped providers (LiteLLM, Poe, Requesty)
   additionally include a short, irreversible discriminator derived from the API key
   (`provider:baseUrl:<discriminator>`) so that two different API keys on the same server never share
   a cache entry (relevant when the server enforces per-key model allowlists). Both the discriminator
   and the on-disk filename digest are derived via truncated PBKDF2 so neither can be reversed to
   identify the API key written to the cache filename. The `RouterProvider.getModel()` cold-start
   fallback is also corrected to pass the full options so it resolves the same compound key.

2. **Silent fallback to hardcoded default**: When the LiteLLM model list was empty (due to the
   collision above, a failed sync, or a transient error), `useSelectedModel` reset the configured
   model ID to `claude-3-7-sonnet-20250219` -- a model that typically does not exist on user
   LiteLLM servers. Four sub-fixes: preserve the configured model ID when the list is empty;
   invalidate the React Query router-models cache after a successful "Sync Models" click; pass the
   current LiteLLM credentials in the debounced `requestRouterModels` message; and correct the
   credential priority in `webviewMessageHandler.ts` so that message values (current unsaved field
   state) take precedence over stale saved config, matching the pattern already used for DeepSeek.
