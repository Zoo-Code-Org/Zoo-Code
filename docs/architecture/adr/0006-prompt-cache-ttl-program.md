# ADR-0006: Prompt-cache TTL program — catalog-embedded per-TTL pricing, opt-in knob, fail-closed capability gates

> RECONSTRUCTED 2026-10-31: the original file (written 261031 ~01:58) was lost in a docs-folder deletion incident (~01:40-02:10 window). This copy is rebuilt verbatim from the session transcript. Report folders are session artifacts; a live backup also exists at C:/Users/k1yt/ZooCode_docs_rebuild/.

## Status

Proposed (2026-10-31). Deciders: @myk1yt (program owner), upstream maintainers for merge. Design produced by a 3-seat double-blind architect swarm; per-seat plans in `docs/261031_0001_session_caching-diet-wave/architect-report-ttl-adr-{mlarge,glm,deep}.md`, reconciliation in `ttl-adr-pick.md` (session artifacts, not committed). Supersedes nothing.

## Context

Zoo-Code emits only bare `{ type: "ephemeral" }` cache markers — no TTL anywhere (`src/api/providers/anthropic.ts:67`, four `src/api/transform/caching/*.ts` transforms, `openai.ts:121,150`, `minimax.ts:85`, Bedrock `{ cachePoint: { type: "default" } }` at `bedrock.ts:1040` + `base-strategy.ts:53-55`). Per-TTL usage splits (`usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`; OpenAI `cache_write_tokens_details.{ttl_30m,ttl_12h}_tokens`) are typed in the pinned SDKs (`messages.d.ts:166-174`; AWS `CacheTTL` enum) but read nowhere — grep over `src/` returns zero hits. `src/shared/cost.ts:50` prices writes at one rate.

Economics (verified by the 261030 caching validation swarm): Anthropic 5m write = 1.25x base input, 1h write = 2.0x. Shipping a TTL knob without per-TTL write splits under-reports every 1h write by **37.5%** (50% for OpenAI's 2.5x 12h class). Break-even for 1h is a single avoided re-write per hour (premium 0.75xP vs saving 1.15xP per expiry event; ~0.65 events/hour). Bedrock hard-fails (`ValidationException`) on a TTL a model does not support.

## Decision Drivers

- Billing correctness (a knob that misprices is worse than no knob; the repo already under-reports DeepSeek-style shape bugs once — PR #2252).
- Single source of truth for price data (catalog), not derived multipliers.
- Zero behavior change by default (byte-identical requests unless the user opts in).
- Hard provider failures are unacceptable (Bedrock gate must fail closed).
- Mutation-diff budget (`MAX_CHANGED_LINES=500` per package) and per-PR reviewability.

## Decision

Adopt **Option A — catalog-embedded per-TTL write prices + a provider-settings opt-in knob** — executed in a staged order so the split-accounting half lands **before** any request can emit 1h:

1. **PR-C5a (accounting only, zero request-shape change):** `ModelInfo` gains optional `cacheWritesPrice1h`/`cacheWritesPrice12h` (populated from a single `deriveCacheWritesPrice1h(inputPrice)` ratio helper, never retyped per entry); usage chunks gain **count-split fields** (`cacheWriteTokens1h`, `cacheWriteTokens12h`) accumulated from the vendor's reported split, with `writes5m = total - 1h - 12h` clamped at 0; `cost.ts` gains optional trailing split params (backward-compatible; existing 55 call sites untouched).
2. **PR-C5b (mechanism):** `promptCacheTtl?: "5m" | "1h"` added to `baseProviderSettingsShape` (provider-settings, **not** global-settings — `ApiHandlerOptions = Omit<ProviderSettings, "apiProvider">`, `src/shared/api.ts:14`, means a global key is invisible to handlers). Emission gated by a catalog capability array `promptCacheTtlSupport?: ("5m"|"1h")[]`; unset knob emits **no `ttl` key at all** (not `"5m"`).
3. **PR-C6 (settings/UI):** the knob ships last and rides the provider-profile round-trip (`apiConfiguration`), satisfying the Persisted Setting Checklist in AGENTS.md with `awsUsePromptCache`/`anthropicBeta1MContext` as precedents; UI disables 1h for models without capability.
4. **PR-C7 (Bedrock per-model gate):** capability comes from the catalog flag on resolved base-model ids (never ARN/custom-id string inference); both cache-point emitters (`base-strategy.ts:54`, `bedrock.ts:1040`) are patched together; requests carry one uniform TTL per request, making AWS's longer-before-shorter ordering hazard structurally unreachable.

Invariants binding all PRs: **I1** price from reported counts, never from the requested TTL, never summing two shapes of the same quantity; **I2** absent capability metadata means 5m-only (fail closed); **I3** default request bytes unchanged; **I4** one uniform TTL per request.

## Alternatives

- **Option B — multiplier table / overrides map outside the catalog (fastest, ~260-280 lines):** dismissed. It creates a second source of truth for write prices; this repo has already lived the drift (Moonshot `cacheWritesPrice: 0 "free for limited time"` staleness, MiMo precedent). Rejected 3/3 seats.
- **Option C — full staging behind a temporary `experiments` flag:** dismissed as shipped design. The flag is a throwaway surface with its own removal cost; C5b's knob is already the opt-in, so a second gate adds nothing. Its *ordering* (accounting first) is adopted into this decision.
- **Global-settings knob location (mlarge variant):** dismissed; provider-settings route verified independently by two seats with the `ApiHandlerOptions` citation.
- **Static Bedrock 1h model-id allowlist const:** dismissed; duplicates capability the catalog already expresses (drift surface), though the repo does carry the `BEDROCK_1M_CONTEXT_MODEL_IDS` precedent for simpler cases.

## Consequences

Positive: the 37.5% under-report becomes unrepresentable before the knob can ship; C5a is a pure reporting fix mergeable on its own; capability and price live in the catalog where pricing reviewers already look; Bedrock cannot be sent an unsupported TTL from the shipped code path.

Negative: ~51 ungated catalog lines across `packages/types/src/providers/{anthropic,bedrock,openai}.ts` must be arithmetically reviewed by hand; `Task.ts` accumulator plumbing (~8 sites) is touched (a missed site silently falls back to the lump rate — mitigated by the catalog-invariant and split tests); a per-provider knob means users with many profiles set TTL per profile, not once globally; OpenRouter pass-through exposes a single `cache_write` figure, so its 1h pricing keeps the documented fallback rather than a split.

## Risks and Mitigations

- **Two Bedrock emitters diverge (mixed TTL request -> 400):** both-emitter test asserting every `cachePoint` carries the ttl (C7 plan).
- **Silent fallback re-hides the bug for a forgotten catalog entry:** invariant test — every Anthropic/Bedrock entry with `supportsPromptCache: true` gets a defined 1h price/capability.
- **Dynamic catalogs (OpenRouter fetcher, custom ARNs) lack capability data:** fail-closed to 5m; if the invariant cannot be enforced, C5a re-specs to omit 1h attribution rather than misprice.
- **Pinned SDK does not actually return the split on some path:** C5a reads via optional chain; if the Anthropic split proves unverifiable without a live call, gate C5b behind one CEO-key probe (same protocol as PR-C8) and ship C5a's OpenAI 12h half only.
- **`applyLongContextPricing` forgetting the new field (>200k-context 1h writes at half rate):** dedicated long-context split test.

## Validation

- The 37.5% tripwire test: 1,000 1h-write tokens at `inputPrice 3.0` must price **0.006**, not 0.00375 (`src/utils/__tests__/cost.spec.ts`).
- Default-parity: knob unset => serialized request contains no `"ttl"` key (snapshot/grep assertions per provider spec).
- Fail-closed gate: `promptCacheTtl:"1h"` + non-capable model => no `ttl` emitted; Bedrock Nova-class row asserted against `ValidationException` shape.
- Settings round-trip: saved `"1h"` survives `getStateToPostToWebview()`; unset stays `undefined` (default applied by consumers).
- Mixed-shape non-additivity fixtures (DeepSeek lesson, PR #2252) on every split reader.

## Revisit Triggers

- AWS publishes/changes the per-model 1h list, or a live probe returns `ValidationException` for 2+ allowlisted models -> re-pin or defer C7 permanently (Bedrock stays 5m).
- Vendors reprice TTL classes away from the 1.25x/2.0x/2.5x ratios -> catalog edit; if per-request mixed TTLs are ever wanted, the uniform-TTL invariant (I4) must gain ordering enforcement first.
- `packages/types` enters the mutation-gate `PACKAGE_CONFIGS` -> re-check C5a line budget. (UPDATE 261031: C3 verified `types` IS in PACKAGE_CONFIGS at scripts/stryker-diff.mjs:40-44 — C5a's catalog lines DO count against the gate; coder measured own 217/500, cumulative 281/500.)
- PR-C8's live Kimi/Moonshot probe returns per-TTL write fields -> extend C5a's readers with the Moonshot lever rather than a new design.

## References

- `docs/261030_0005_session_diet-caching-validation/FINAL-PLAN.md` (K5/K8 rows, DO-NOT list)
- Architect seat reports + pick record (session folder `docs/261031_0001_session_caching-diet-wave/`)
- PR #2252 (wire-shape lesson: fixtures must match vendor schema), PR #2260 (C5a implementation)
- ADR-0003, ADR-0005 (repo ADR numbering/format precedent)
