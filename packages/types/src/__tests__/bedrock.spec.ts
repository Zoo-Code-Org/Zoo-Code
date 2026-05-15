import type { ModelInfo } from "../model.js"
import type { BedrockDiscoveredTarget } from "../providers/bedrock.js"
import {
	BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS,
	BEDROCK_GLOBAL_INFERENCE_MODEL_IDS,
	BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS,
	bedrockModels,
	expandBedrockTargetsWith1MVariants,
	hasBedrock1MContextIndicator,
	resolveBedrockModelInfo,
	stripBedrock1MContextSuffix,
} from "../providers/bedrock.js"

describe("Bedrock model catalog", () => {
	it("includes Claude Opus 4.7 with flat $5/$25 pricing across its 200K base and 1M tier", () => {
		// `bedrockModels` is typed as a giant discriminated union across every model entry,
		// so narrowing to `ModelInfo` lets us read the common fields without per-model checks.
		const opus47 = bedrockModels["anthropic.claude-opus-4-7" as keyof typeof bedrockModels] as ModelInfo
		expect(opus47).toBeDefined()
		expect(opus47.contextWindow).toBe(200_000)
		expect(opus47.supportsReasoningBudget).toBe(true)
		expect(opus47.inputPrice).toBe(5.0)
		expect(opus47.outputPrice).toBe(25.0)

		// Tier exists only so the dropdown split can offer a 1M variant; pricing is flat.
		const tier = opus47.tiers?.[0]
		expect(tier).toBeDefined()
		expect(tier?.contextWindow).toBe(1_000_000)
		expect(tier?.inputPrice).toBe(5.0)
		expect(tier?.outputPrice).toBe(25.0)
	})

	it("flags Opus 4.7 as a native-1M model (so beta flags are NOT sent at runtime)", () => {
		expect(BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS).toContain("anthropic.claude-opus-4-7")
	})

	it("includes Opus 4.7 in the 1M-capable and global-inference lists", () => {
		expect(BEDROCK_1M_CONTEXT_MODEL_IDS).toContain("anthropic.claude-opus-4-7")
		expect(BEDROCK_GLOBAL_INFERENCE_MODEL_IDS).toContain("anthropic.claude-opus-4-7")
	})

	it("makes every 1M-capable model opt-in (empty default list)", () => {
		// Previously Sonnet 4.6 and Opus 4.6 auto-advertised 1M; the new dual-variant dropdown
		// presents both context tiers explicitly, so no model is auto-flipped anymore.
		expect(BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS.length).toBe(0)
		expect(BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS.length).toBe(BEDROCK_1M_CONTEXT_MODEL_IDS.length)
	})

	it("matches per-model maxTokens to the documented Bedrock caps for current Anthropic models", () => {
		// These caps mirror the Anthropic-direct entries in `anthropic.ts`. Bumping them lets the
		// reasoning-budget slider extend past the legacy 8K cap (the original bug surfaced by Opus 4.7).
		expect((bedrockModels["anthropic.claude-opus-4-7"] as ModelInfo).maxTokens).toBe(128_000)
		expect((bedrockModels["anthropic.claude-opus-4-6-v1"] as ModelInfo).maxTokens).toBe(128_000)
		expect((bedrockModels["anthropic.claude-opus-4-5-20251101-v1:0"] as ModelInfo).maxTokens).toBe(32_000)
		expect((bedrockModels["anthropic.claude-opus-4-1-20250805-v1:0"] as ModelInfo).maxTokens).toBe(32_000)
		expect((bedrockModels["anthropic.claude-sonnet-4-6"] as ModelInfo).maxTokens).toBe(64_000)
		expect((bedrockModels["anthropic.claude-sonnet-4-5-20250929-v1:0"] as ModelInfo).maxTokens).toBe(64_000)
		expect((bedrockModels["anthropic.claude-haiku-4-5-20251001-v1:0"] as ModelInfo).maxTokens).toBe(64_000)
	})

	it("marks AWS-documented Claude 4.5 models for 1-hour Bedrock prompt cache TTL", () => {
		expect((bedrockModels["anthropic.claude-sonnet-4-5-20250929-v1:0"] as ModelInfo).promptCacheTtl).toBe("1h")
		expect((bedrockModels["anthropic.claude-haiku-4-5-20251001-v1:0"] as ModelInfo).promptCacheTtl).toBe("1h")
		expect((bedrockModels["anthropic.claude-opus-4-5-20251101-v1:0"] as ModelInfo).promptCacheTtl).toBe("1h")
	})
})

describe("resolveBedrockModelInfo", () => {
	it("prefers the static maxTokens when no override is set", () => {
		const { info } = resolveBedrockModelInfo({
			baseModelId: "anthropic.claude-opus-4-7",
			targetId: "anthropic.claude-opus-4-7",
		})
		expect(info.maxTokens).toBe(128_000)
	})

	it("applies maxOutputTokensOverride above the static cap", () => {
		const { info } = resolveBedrockModelInfo({
			baseModelId: "anthropic.claude-opus-4-7",
			targetId: "anthropic.claude-opus-4-7",
			maxOutputTokensOverride: 256_000,
		})
		expect(info.maxTokens).toBe(256_000)
	})

	it("lets request-time modelMaxTokens still override (lowering for cost control)", () => {
		const { info } = resolveBedrockModelInfo({
			baseModelId: "anthropic.claude-opus-4-7",
			targetId: "anthropic.claude-opus-4-7",
			maxOutputTokensOverride: 256_000,
			modelMaxTokens: 32_000,
		})
		expect(info.maxTokens).toBe(32_000)
	})
})

describe("expandBedrockTargetsWith1MVariants", () => {
	const makeTarget = (overrides: Partial<BedrockDiscoveredTarget> = {}): BedrockDiscoveredTarget => ({
		id: "anthropic.claude-opus-4-6-v1",
		label: "Claude Opus 4.6",
		baseModelId: "anthropic.claude-opus-4-6-v1",
		targetKind: "foundation-model",
		contextWindow: 200_000,
		contextSource: "base",
		...overrides,
	})

	it("emits two entries for a 1M-capable base target: default + :1m variant", () => {
		const expanded = expandBedrockTargetsWith1MVariants([makeTarget()])

		expect(expanded).toHaveLength(2)
		const [base, oneM] = expanded as [BedrockDiscoveredTarget, BedrockDiscoveredTarget]
		expect(base.id).toBe("anthropic.claude-opus-4-6-v1")
		expect(base.contextWindow).toBe(200_000)
		expect(oneM.id).toBe("anthropic.claude-opus-4-6-v1:1m")
		expect(oneM.contextWindow).toBe(1_000_000)
		expect(oneM.label).toMatch(/1M context/i)
		expect(oneM.contextSource).toBe("profile-id")
	})

	it("also emits two entries when AWS discovery returns a system profile id", () => {
		const expanded = expandBedrockTargetsWith1MVariants([
			makeTarget({
				id: "us.anthropic.claude-opus-4-7",
				baseModelId: "anthropic.claude-opus-4-7",
				targetKind: "system-profile",
				label: "Claude Opus 4.7 (us.anthropic.claude-opus-4-7)",
			}),
		])

		expect(expanded).toHaveLength(2)
		const oneM = expanded[1] as BedrockDiscoveredTarget
		expect(oneM.id).toBe("us.anthropic.claude-opus-4-7:1m")
		expect(hasBedrock1MContextIndicator(oneM.id)).toBe(true)
		expect(stripBedrock1MContextSuffix(oneM.id)).toBe("us.anthropic.claude-opus-4-7")
	})

	it("leaves non-1M-capable targets untouched", () => {
		const expanded = expandBedrockTargetsWith1MVariants([
			makeTarget({
				id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				baseModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			}),
		])

		expect(expanded).toHaveLength(1)
		expect((expanded[0] as BedrockDiscoveredTarget).id).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0")
	})

	it("does not double-expand a target that already represents the 1M variant", () => {
		const expanded = expandBedrockTargetsWith1MVariants([
			makeTarget({ id: "anthropic.claude-opus-4-6-v1:1m", contextWindow: 1_000_000 }),
		])

		expect(expanded).toHaveLength(1)
		expect((expanded[0] as BedrockDiscoveredTarget).id).toBe("anthropic.claude-opus-4-6-v1:1m")
	})
})
