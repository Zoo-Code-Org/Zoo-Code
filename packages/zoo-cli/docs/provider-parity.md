# Zoo CLI Provider Parity Audit

This audit compares the current Zoo/Roo VS Code provider handlers with the imported Zoo CLI provider stack. The CLI primarily uses the OpenCode `models.dev` BYOK catalog plus config-defined OpenAI-compatible providers, so some VS Code-specific handlers map to dynamic catalog entries instead of one source file.

## CLI Provider Sources

- `packages/zoo-cli/src/provider/models.ts` loads `models.dev` data and falls back to `models-snapshot.ts`.
- `packages/zoo-cli/src/provider/provider.ts` registers bundled AI SDK adapters and custom provider loaders.
- `packages/zoo-cli/src/kilocode/provider/provider.ts` contains Kilo-era provider patches still present in the imported core.

## VS Code Provider Parity

| VS Code provider    | VS Code handler                                      | CLI status                                                 | Notes                                                                                                                 |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `anthropic`         | `src/api/providers/anthropic.ts`                     | Supported                                                  | Native CLI loader plus `models.dev`.                                                                                  |
| `openrouter`        | `src/api/providers/openrouter.ts`                    | Supported                                                  | Native CLI loader plus `models.dev`.                                                                                  |
| `bedrock`           | `src/api/providers/bedrock.ts`                       | Supported as `amazon-bedrock`                              | CLI provider ID differs from VS Code.                                                                                 |
| `vertex`            | `src/api/providers/vertex.ts`, `anthropic-vertex.ts` | Supported as `google-vertex` and `google-vertex-anthropic` | CLI provider IDs differ from VS Code.                                                                                 |
| `openai`            | `src/api/providers/openai.ts`                        | Supported                                                  | Use CLI OpenAI-compatible config/provider entries.                                                                    |
| `openai-native`     | `src/api/providers/openai-native.ts`                 | Supported as `openai`                                      | Native OpenAI loader exists in CLI.                                                                                   |
| `gemini`            | `src/api/providers/gemini.ts`                        | Supported as `google` catalog entries                      | Provided through `models.dev`/AI SDK.                                                                                 |
| `mistral`           | `src/api/providers/mistral.ts`                       | Supported                                                  | AI SDK adapter and model transforms exist.                                                                            |
| `xai`               | `src/api/providers/xai.ts`                           | Supported                                                  | Native CLI loader exists.                                                                                             |
| `fireworks`         | `src/api/providers/fireworks.ts`                     | Supported as `fireworks-ai`                                | CLI provider ID differs from VS Code.                                                                                 |
| `minimax`           | `src/api/providers/minimax.ts`                       | Supported through catalog entries                          | Catalog includes MiniMax variants.                                                                                    |
| `zai`               | `src/api/providers/zai.ts`                           | Supported through catalog entries                          | Catalog includes Z.AI/Zhipu variants.                                                                                 |
| `deepseek`          | `src/api/providers/deepseek.ts`                      | Supported through catalog entries                          | DeepSeek model transforms exist.                                                                                      |
| `moonshot`          | `src/api/providers/moonshot.ts`                      | Supported through catalog entries                          | Catalog includes Moonshot/Kimi variants.                                                                              |
| `qwen-code`         | `src/api/providers/qwen-code.ts`                     | Supported through Alibaba/Qwen catalog entries             | Needs runtime smoke coverage.                                                                                         |
| `ollama`            | `src/api/providers/native-ollama.ts`                 | Supported via OpenAI-compatible config                     | Native Ollama protocol is deferred; configure Ollama's `/v1` compatibility endpoint.                                  |
| `lmstudio`          | `src/api/providers/lm-studio.ts`                     | Supported through catalog entries                          | Catalog maps LM Studio to `http://127.0.0.1:1234/v1`; local availability still depends on a running LM Studio server. |
| `litellm`           | `src/api/providers/lite-llm.ts`                      | Supported via OpenAI-compatible config                     | Configure the LiteLLM proxy endpoint with `@ai-sdk/openai-compatible`.                                                |
| `requesty`          | `src/api/providers/requesty.ts`                      | Supported through catalog entries                          | Catalog maps Requesty to `https://router.requesty.ai/v1` with `REQUESTY_API_KEY`.                                     |
| `unbound`           | `src/api/providers/unbound.ts`                       | Supported via OpenAI-compatible config                     | Bespoke Unbound metadata headers are not injected by default; add them in config if required.                         |
| `sambanova`         | `src/api/providers/sambanova.ts`                     | Supported via OpenAI-compatible config                     | Configure SambaNova's OpenAI-compatible endpoint with `@ai-sdk/openai-compatible`.                                    |
| `baseten`           | `src/api/providers/baseten.ts`                       | Supported through catalog entries                          | Catalog maps Baseten to `https://inference.baseten.co/v1`; request transform coverage keeps thinking enabled.         |
| `poe`               | `src/api/providers/poe.ts`                           | Supported through catalog entries                          | CLI uses Poe's OpenAI-compatible API rather than the VS Code-specific Poe provider package.                           |
| `vercel-ai-gateway` | `src/api/providers/vercel-ai-gateway.ts`             | Deferred                                                   | CLI has Vercel AI SDK support, but no Zoo gateway should be introduced.                                               |
| `openai-codex`      | `src/api/providers/openai-codex.ts`                  | Deferred                                                   | ChatGPT Plus/Pro flow is extension-specific and requires product decision.                                            |
| `vscode-lm`         | `src/api/providers/vscode-lm.ts`                     | Not applicable                                             | VS Code host API provider, not usable from CLI.                                                                       |
| `fake-ai`           | `src/api/providers/fake-ai.ts`                       | Test-only                                                  | Keep as extension test provider unless CLI smoke tests need a deterministic mock.                                     |
| `roo`               | `src/api/providers/roo.ts`                           | Not supported                                              | Existing VS Code path is disabled by router-removal behavior. Do not reintroduce a gateway without a Zoo cloud plan.  |

## Follow-Up Implementation Notes

- Keep provider onboarding BYOK and catalog/config based; do not reintroduce active Kilo gateway dependencies.
- Prefer config fixtures before adding bespoke handlers for OpenAI-compatible providers.
- Provider parity coverage now lives in `test/provider/zoo-provider-parity.test.ts`; broader imported provider tests remain quarantined until their Kilo/plugin/auth assumptions are rewritten.
