# AetherAPI Provider Integration

## Summary

Add AetherAPI (`https://api.aetherapi.dev/v1`) as a new OpenAI-compatible LLM provider in zoo-code.

## Model

- **ID**: `kimi-k2.6`
- **Context Window**: 262,144 tokens
- **Supports Images**: yes
- **Supports Tool Calls**: yes
- **Input Price**: $0.42 / 1M tokens
- **Output Price**: $1.96 / 1M tokens

## Architecture

Follow the existing `BaseOpenAiCompatibleProvider` pattern used by Fireworks, Together, etc.

### Files to Create

1. `packages/types/src/providers/aetherapi.ts` — model metadata
2. `src/api/providers/aetherapi.ts` — API handler
3. `webview-ui/src/components/settings/providers/Aetherapi.tsx` — settings UI

### Files to Modify

1. `packages/types/src/provider-settings.ts` — add `aetherapi` to enums, schemas, mappings
2. `packages/types/src/providers/index.ts` — export model metadata
3. `src/api/providers/index.ts` — export handler
4. `src/api/index.ts` — factory case
5. `webview-ui/src/components/settings/constants.ts` — provider list + models
6. `webview-ui/src/components/settings/utils/providerModelConfig.ts` — service config + default model
7. `webview-ui/src/components/settings/ApiOptions.tsx` — wire UI component
8. `webview-ui/src/components/settings/providers/index.ts` — export component
9. `webview-ui/src/i18n/locales/en/settings.json` — translation keys

## Settings

- `aetherapiApiKey` (optional, string)
- `aetherapiBaseUrl` (optional, string, default: `https://api.aetherapi.dev/v1`)

## Error Handling

Inherited from `BaseOpenAiCompatibleProvider` via `handleOpenAIError`.
