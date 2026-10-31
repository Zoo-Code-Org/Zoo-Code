// npx vitest run src/__tests__/prompt-cache-ttl.test.ts

import { describe, it, expect } from "vitest"

import { anthropicModels } from "../providers/anthropic.js"
import { vertexModels } from "../providers/vertex.js"
import { openRouterDefaultModelInfo } from "../providers/openrouter.js"
import {
	vercelAiGatewayDefaultModelId,
	VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS,
} from "../providers/vercel-ai-gateway.js"
import {
	DEFAULT_PROMPT_CACHE_TTL,
	modelInfoSchema,
	promptCacheTtlSchema,
	promptCacheTtlValues,
	type ModelInfo,
} from "../model.js"
import { anthropicProviderDefinition } from "../provider-settings/anthropic.js"
import { baseProviderSettingsShape } from "../provider-settings/common.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { globalSettingsSchema } from "../global-settings.js"

/**
 * Catalog invariant for the request-side TTL knob (ADR-0006 phase 2, PR-C5b).
 *
 * Emission is gated by `ModelInfo.promptCacheTtlSupport`, so a model that can
 * report a 1h cache write but carries no capability array would silently never
 * emit the TTL the user asked for. These tests pin both directions: capable
 * catalogs advertise it, and catalogs that cannot know stay absent (fail closed).
 */
describe("prompt cache TTL schema", () => {
	it("accepts exactly the 5m and 1h classes", () => {
		expect(promptCacheTtlValues).toEqual(["5m", "1h"])
		expect(promptCacheTtlSchema.parse("5m")).toBe("5m")
		expect(promptCacheTtlSchema.parse("1h")).toBe("1h")
		expect(promptCacheTtlSchema.safeParse("30m").success).toBe(false)
		expect(promptCacheTtlSchema.safeParse("12h").success).toBe(false)
	})

	it("defaults to undefined so an unset knob emits no ttl key", () => {
		expect(DEFAULT_PROMPT_CACHE_TTL).toBeUndefined()
	})

	it("is optional on ModelInfo", () => {
		const parsed = modelInfoSchema.parse({ contextWindow: 200_000, supportsPromptCache: true })
		expect(parsed.promptCacheTtlSupport).toBeUndefined()

		const withCapability = modelInfoSchema.parse({
			contextWindow: 200_000,
			supportsPromptCache: true,
			promptCacheTtlSupport: ["5m", "1h"],
		})
		expect(withCapability.promptCacheTtlSupport).toEqual(["5m", "1h"])
	})
})

describe("prompt cache TTL knob location", () => {
	it("lives in provider settings so handlers can see it", () => {
		// ApiHandlerOptions = Omit<ProviderSettings, "apiProvider">, so only a
		// provider-settings key reaches a handler (ADR-0006 decision item 2).
		expect(baseProviderSettingsShape.promptCacheTtl).toBeDefined()

		const parsed = anthropicProviderDefinition.schema.safeParse({
			apiProvider: providerIdentifiers.anthropic,
			promptCacheTtl: "1h",
		})
		expect(parsed.success).toBe(true)
		expect(parsed.success && parsed.data.promptCacheTtl).toBe("1h")
	})

	it("is not a global setting", () => {
		const shape = globalSettingsSchema.shape as Record<string, unknown>
		expect(shape.promptCacheTtl).toBeUndefined()
	})
})

describe("prompt cache TTL capability catalog", () => {
	it("every Anthropic entry with prompt caching advertises both TTL classes", () => {
		const missing = Object.entries(anthropicModels as Record<string, ModelInfo>)
			.filter(([, info]) => info.supportsPromptCache && !info.promptCacheTtlSupport?.includes("1h"))
			.map(([id]) => id)

		expect(missing).toEqual([])
	})

	it("leaves the Vertex catalog without capability so it fails closed", () => {
		// PR-C5b scopes the catalog capability to the Anthropic entries; the Vertex
		// catalog is populated separately, so its models stay 5m-only for now.
		const withCapability = Object.entries(vertexModels as Record<string, ModelInfo>)
			.filter(([, info]) => info.promptCacheTtlSupport !== undefined)
			.map(([id]) => id)

		expect(withCapability).toEqual([])
	})

	it("leaves dynamic-catalog defaults without capability so they fail closed", () => {
		// OpenRouter and the gateway catalogs are fetched at runtime and carry no TTL
		// capability data, which ADR-0006 maps to "5m only" (invariant I2).
		expect(openRouterDefaultModelInfo.promptCacheTtlSupport).toBeUndefined()
		expect(VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS.has(vercelAiGatewayDefaultModelId)).toBe(true)
	})
})
