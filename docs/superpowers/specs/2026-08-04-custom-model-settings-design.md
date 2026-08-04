# Custom Model Settings Override

**Date:** 2026-08-04
**Status:** Approved, ready for implementation plan

## Problem

A user selects a model ID that is not present in a router provider's fetched
model list — for example typing `anthropic/claude-sonnet-4-6` into the
OpenRouter model picker via the "use custom model" affordance
(`webview-ui/src/components/settings/ModelPicker.tsx:277`). Three distinct
defects follow.

### Defect 1 — context window collapses to `1`, percentage renders as 7000%

`webview-ui/src/components/chat/TaskHeader.tsx:72`:

```ts
const contextWindow = model?.contextWindow || 1
```

When `useSelectedModel` cannot resolve the model, `model` is `undefined` and
`contextWindow` becomes `1`. That value flows into the percentage at
`TaskHeader.tsx:253-258`:

```ts
const availableInputSpace = contextWindow - reservedForOutput
const percentage =
    availableInputSpace > 0
        ? Math.round(((contextTokens || 0) / availableInputSpace) * 100)
        : 0
```

With `contextWindow === 1` and `reservedForOutput === 0`, `availableInputSpace`
is `1`, so the percentage equals `contextTokens * 100`. 70 context tokens
render as **7000%**. There is no upper clamp on this path.

**Precise trigger.** For OpenRouter an unknown ID is normally rewritten to the
default model by `getValidatedModelId`
(`webview-ui/src/components/ui/hooks/useSelectedModel.ts:56`), which yields a
valid `info`. The `undefined` case therefore arises when the router model list
is empty rather than merely missing the ID: no API key configured, a failed or
in-flight fetch, or offline. In that state the default-model lookup also misses,
`info` is `undefined`, and the `|| 1` fallback produces both the "token limit
shows 1" symptom and the 7000% reading. They are two faces of one fault.

### Defect 2 — webview and extension host disagree on the model

`getValidatedModelId` silently substitutes the provider default when the
configured ID is absent from the list, while `openRouterModelId` continues to
hold the user's typed value. The extension host does not perform the same
substitution — `src/api/providers/openrouter.ts:554`:

```ts
let info = this.models[id] ?? openRouterDefaultModelInfo
```

The host sends the user's real ID with a 200K-context default profile; the
webview displays a different model entirely. Requests may succeed while the UI
describes something else.

### Defect 3 — no override UI outside the OpenAI-compatible provider

`openAiCustomModelInfo` (`packages/types/src/provider-settings.ts:245`) is the
only user-facing way to supply `contextWindow` / `maxTokens`, and it is wired
solely to the `openai` provider's settings panel
(`webview-ui/src/components/settings/providers/OpenAICompatible.tsx:286-347`).
OpenRouter, Requesty, Unbound, Vercel AI Gateway and Zoo Gateway offer no
equivalent, so a custom model on those providers can never be given correct
token limits.

## Goals

1. Let the user override context window and max output tokens for any model on
   the router providers, and have that override govern both the UI and the real
   request/truncation path.
2. Ensure the UI never displays a nonsensical figure when no override is set.

## Non-goals

- Editing per-token pricing. Overridden prices would corrupt cost reporting;
  that is separate work.
- Migrating or removing `openAiCustomModelInfo`. It keeps working unchanged.
- Reworking `ModelPicker`'s custom-model entry flow.

## Architecture

Two layers resolve model info independently and must not diverge:

| Layer | Resolver |
|---|---|
| Webview | `getSelectedModel()` in `useSelectedModel.ts:132` |
| Extension host | each provider's `getModel()` (30 implementations) |

An override applied to only one layer would fix the display while leaving
context truncation wrong. The design therefore applies one shared helper at both
layers, each through a single chokepoint.

Two facts from the codebase make the host-side chokepoint viable: there is
exactly one factory, `buildApiHandler` (`src/api/index.ts:153`), and no
`instanceof <X>Handler` check exists anywhere in `src/`. A wrapper around the
returned handler is therefore safe.

### Data model

Add one field to `baseProviderSettingsSchema`
(`packages/types/src/provider-settings.ts:176`):

```ts
customModelInfo: modelInfoSchema.partial().nullish(),
```

`partial()` is deliberate. The field is an **overlay**, not a replacement: a user
who sets only `contextWindow` keeps the fetched values for price, image support
and reasoning. Placing it on the base schema means every provider inherits it,
avoiding the five near-identical fields that a per-provider approach would need.

`openAiCustomModelInfo` remains as-is. Where both are present, `customModelInfo`
is applied second and wins on the fields it defines.

### Shared helper

In `packages/types` (importable by both webview and host):

```ts
applyCustomModelInfo(
    info: ModelInfo | undefined,
    settings: { customModelInfo?: Partial<ModelInfo> | null } | undefined,
): ModelInfo | undefined
```

Behaviour:

- `info` present → return `info` with the override's **defined and valid** keys
  merged over it.
- `info` absent but the override supplies a positive `contextWindow` → synthesise
  a `ModelInfo` from a synthesis base plus the override. This is what makes a
  genuinely unknown model usable.
- Neither → return `undefined`, preserving today's "invalid selection" signal.

The synthesis base is defined locally rather than reusing
`openAiModelInfoSaneDefaults`, whose `maxTokens: -1` sentinel
(`packages/types/src/providers/openai.ts:692-693`) would propagate a negative
value into arithmetic:

```ts
const CUSTOM_MODEL_SYNTHESIS_BASE = {
    maxTokens: undefined,
    supportsImages: false,
    supportsPromptCache: false,
} satisfies Partial<ModelInfo>
```

`contextWindow` is deliberately absent from the base: synthesis only runs when
the override supplies a positive one, so the merged result always has a real
value and never a fabricated default.

Leaving `maxTokens` undefined is safe rather than lossy. `getModelMaxOutputTokens`
(`src/shared/api.ts:131-133`) supplies `ANTHROPIC_DEFAULT_MAX_TOKENS` whenever the
model ID contains `claude` and `maxTokens` is absent — which covers the reported
`anthropic/claude-sonnet-4-6` case. For non-Anthropic IDs it returns `undefined`
(line 158-160), which `TaskHeader` already handles by reserving nothing.

A key is treated as "valid" when it is not `undefined`/`null`, and — for the
numeric fields `contextWindow` and `maxTokens` — is a finite number greater than
zero. Invalid entries are dropped, never coerced to `0`, because
`contextWindow: 0` would reproduce the original division fault.

### Integration points

**Webview** — apply the helper to the `{ id, info }` produced by the ternary at
`useSelectedModel.ts:98-113`, not to `getSelectedModel()`'s return. That ternary
has three branches: the resolved call, a `kimi-code` fallback, and a
not-ready/invalid-provider fallback that yields `info: undefined`. The override
must cover all three — the third is precisely the still-loading state that
produces the reported symptom, and `getSelectedModel()` is not called there at
all. Applying it after the ternary covers every branch and leaves the 30 `switch`
cases untouched.

**Host** — in `buildApiHandler`, wrap the constructed handler in a `Proxy` that
decorates `getModel()` and forwards everything else. Forwarding uses
`Reflect.get(target, prop, target)` — passing `target` rather than the proxy as
receiver, so private class fields continue to resolve. All twelve
`this.api.getModel().info` consumers in `Task.ts` inherit the corrected value,
including the context-window-exceeded and condense paths.

### Display hardening

Independent of any override, so the UI is correct when the user sets nothing:

- `TaskHeader.tsx:72` — drop `|| 1`. When no context window is known, skip
  rendering the percentage entirely rather than printing a fabricated number.
- `TaskHeader.tsx:253-258` — clamp the upper bound with `Math.min(100, …)` and
  render at/over 100% in a warning colour. Keep the existing
  `availableInputSpace > 0` guard: it is the lower bound, and an over-large
  `maxTokens` override can still drive `availableInputSpace` to zero or below.
- `useSelectedModel.ts:51-57` — stop substituting the provider default for a
  configured-but-unlisted ID on the router providers. The condition is *the
  configured ID is absent from the list*, which covers both an empty list and a
  populated list that lacks the user's custom ID; the current guard conflates
  them. The litellm case (lines 178-189) is the in-repo precedent for returning
  the configured ID untouched.

  This aligns the webview with the host, which never substitutes — closing
  Defect 2's divergence. It does not make the two produce identical `info`: the
  host still falls back to `openRouterDefaultModelInfo` (200K) at
  `openrouter.ts:554` while the webview yields `undefined`. Full convergence is
  what the shared helper delivers once an override exists, and is why the helper
  must be bound at both layers rather than the webview alone.

  Callers that assume a non-empty, listed ID must be checked. `ModelPicker`
  already tolerates it: `modelIds` explicitly retains `selectedModelId`
  (lines 122-127) and the initialization effect at 187-194 only fires when
  `selectedModelId` is falsy, so a preserved custom ID is displayed rather than
  overwritten.

### UI

New shared component `CustomModelInfoSettings.tsx`, following the field pattern
already established in `OpenAICompatible.tsx` (text field, green/red border
validation, label plus description). Rendered beneath `ModelPicker` for the
router providers: OpenRouter, Requesty, Unbound, Vercel AI Gateway, Zoo Gateway.

Collapsible, collapsed by default. It auto-expands, with an explanatory note,
when the selected model has no resolved info — the exact situation this feature
addresses.

Fields: **context window**, **max output tokens**, **supportsImages**,
**supportsPromptCache**. A "reset to detected values" control clears the
override.

New i18n keys under `settings:providers.customModelInfo.*` in
`webview-ui/src/i18n/locales/en/settings.json`. Only English is authored; other
locales fall back until translated.

## Error handling

| Input | Result |
|---|---|
| Empty string | Key omitted from overlay |
| `NaN` / non-numeric | Key omitted, red border |
| `<= 0` | Key omitted, red border |
| Valid positive integer | Applied, green border |

`maxTokens` exceeding `contextWindow` is accepted but flagged with an inline
warning. The 20% context-window clamp in `getModelMaxOutputTokens`
(`src/shared/api.ts:154`) is **not** a reliable backstop here — three earlier
branches return before reaching it: reasoning-budget models (line 117), Anthropic
contexts with `supportsReasoningBudget` or absent `maxTokens` (lines 126-133),
and `supportsMaxTokens` models honouring an explicit `modelMaxTokens` (line 138).
The first two are exactly the `anthropic/claude-*` path in this bug report.

Since the clamp cannot be relied on, the inline warning is the actual guard, and
`TaskHeader`'s `availableInputSpace` must tolerate `reservedForOutput >=
contextWindow`. Its existing `> 0` guard already returns `0%` rather than a
negative percentage; the display-hardening change must preserve that guard rather
than replace it with the new `Math.min(100, …)` clamp.

## Testing

- `applyCustomModelInfo` unit tests: overlay onto existing info; synthesis from
  absent info; empty/invalid/zero/negative input dropped rather than coerced;
  `undefined` returned when nothing is available.
- `TaskHeader` regression test: with `info === undefined`, assert no `7000%`-class
  output — the percentage element is absent. This is the lock on the reported bug.
- `TaskHeader` clamp test: `contextTokens` exceeding the window renders `100%`,
  not more.
- `useSelectedModel` tests: an empty router model list preserves the configured
  custom ID rather than substituting the default; a *populated* list that lacks
  the configured ID also preserves it. The second case is the one the current
  guard gets wrong.
- `useSelectedModel` test: the override applies in the not-ready branch (router
  models still loading), where `getSelectedModel()` is never called.
- `buildApiHandler` proxy test: `getModel()` reflects the override while other
  methods and private field access remain intact.
- `CustomModelInfoSettings` component tests: validation borders, persistence,
  reset, auto-expansion when info is unresolved.

## Files affected

| File | Change |
|---|---|
| `packages/types/src/provider-settings.ts` | Add `customModelInfo` to base schema |
| `packages/types/src/model.ts` (or sibling) | Add `applyCustomModelInfo` + synthesis base |
| `webview-ui/src/components/ui/hooks/useSelectedModel.ts` | Apply helper after the ternary (98-113); stop substituting the default for an unlisted ID |
| `src/api/index.ts` | Proxy-wrap handler in `buildApiHandler` |
| `webview-ui/src/components/chat/TaskHeader.tsx` | Remove `\|\| 1`; clamp; conditional render |
| `webview-ui/src/components/settings/CustomModelInfoSettings.tsx` | New component |
| `webview-ui/src/components/settings/providers/{OpenRouter,Requesty,Unbound,VercelAiGateway,ZooGateway}.tsx` | Mount component |
| `webview-ui/src/i18n/locales/en/settings.json` | New keys |

## Risks

- **Proxy overhead** — `getModel()` is called frequently (twelve sites in
  `Task.ts` alone). The decoration is a shallow object spread over a plain
  object; negligible, but the overlay should not be recomputed per call beyond
  that.
- **Stale override after model switch** — an override set for one custom model
  persists when the user picks a different one. Accepted: the reset control and
  the collapsed-by-default panel keep this visible. Auto-clearing on model change
  risks discarding deliberate configuration.
