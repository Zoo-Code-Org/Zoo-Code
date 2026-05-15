// kilocode_change - new file
//
// Kilo-specific provider logic extracted from packages/opencode/src/provider/provider.ts
// to minimize merge conflicts with upstream opencode.
//
// This module exports patch functions and data that the upstream provider.ts
// calls at well-defined injection points (each marked with kilocode_change).

import { DEFAULT_HEADERS } from "@/kilocode/const"
import { Effect, Schema } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { mapValues, omit, pickBy } from "remeda"

/** Default timeout (ms) for provider HTTP requests (connection phase). */
export const REQUEST_TIMEOUT_MS = 120_000 // 2 minutes

// ---------------------------------------------------------------------------
// Bundled providers
// ---------------------------------------------------------------------------

type BundledSDK = { languageModel(modelId: string): LanguageModelV3 }

export const KILO_BUNDLED_PROVIDERS: Record<string, () => Promise<(options: any) => BundledSDK>> = {}

// ---------------------------------------------------------------------------
// Model schema extensions  (spread into Provider.Model Schema.Struct)
// ---------------------------------------------------------------------------

export const KILO_MODEL_SCHEMA_EXTENSIONS = {
	recommendedIndex: Schema.optional(Schema.Number),
	prompt: Schema.optional(Schema.String),
	isFree: Schema.optional(Schema.Boolean),
	ai_sdk_provider: Schema.optional(Schema.String),
}

// ---------------------------------------------------------------------------
// fromModelsDevModel patch — returns kilo-specific fields
// ---------------------------------------------------------------------------

export function patchModelsDevModel(providerID: string, source: any) {
	return {
		variants: providerID === "kilo" ? (source.variants ?? {}) : {},
		recommendedIndex: source.recommendedIndex,
		prompt: source.prompt,
		isFree: source.isFree,
		ai_sdk_provider: source.ai_sdk_provider,
		options: source.options ?? {},
	}
}

// ---------------------------------------------------------------------------
// Config model patch — merges kilo-specific fields from config + existing
// ---------------------------------------------------------------------------

export function patchConfigModel(cfg: any, existing: any) {
	return {
		recommendedIndex: cfg.recommendedIndex ?? existing?.recommendedIndex,
		prompt: cfg.prompt ?? existing?.prompt,
		isFree: cfg.isFree ?? existing?.isFree,
		ai_sdk_provider: cfg.ai_sdk_provider ?? existing?.ai_sdk_provider,
		variants: cfg.variants
			? mapValues(
					pickBy(cfg.variants, (v) => !!v && !v.disabled),
					(v) => omit(v, ["disabled"]),
				)
			: {},
	}
}

// ---------------------------------------------------------------------------
// Custom loaders (new or fully-replaced loaders)
// ---------------------------------------------------------------------------

type CustomDep = {
	auth: (id: string) => Effect.Effect<any | undefined>
	config: () => Effect.Effect<any>
	env: () => Effect.Effect<Record<string, string | undefined>>
	get: (key: string) => Effect.Effect<string | undefined>
}

// Mirrors upstream's CustomLoader return type so Object.entries preserves proper typing
type CustomLoaderResult = {
	autoload: boolean
	getModel?: (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
	vars?: (options: Record<string, any>) => Record<string, string>
	options?: Record<string, any>
	discoverModels?: () => Promise<Record<string, any>>
}

type CustomLoader = (provider: any) => Effect.Effect<CustomLoaderResult>

function shouldUseCopilotResponsesApi(modelID: string): boolean {
	const match = /^gpt-(\d+)/.exec(modelID)
	if (!match) return false
	return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
}

function useLanguageModel(sdk: any) {
	return sdk.responses === undefined && sdk.chat === undefined
}

export function kiloCustomLoaders(dep: CustomDep): Record<string, CustomLoader> {
	return {
		"github-copilot-enterprise": () =>
			Effect.succeed({
				autoload: false,
				async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
					if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
					return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
				},
				options: {},
			}),

		// Override opencode to prevent auto-connecting without credentials
		opencode: () =>
			Effect.succeed({
				autoload: false,
				options: { headers: DEFAULT_HEADERS },
			}),
	}
}

// ---------------------------------------------------------------------------
// Post-processing for custom loader results
// Patches options/headers for providers whose upstream loaders we don't fully
// replace but where specific values differ (headers, branding, env vars).
// ---------------------------------------------------------------------------

export function patchCustomLoaderResult(
	providerID: string,
	result: { options?: Record<string, any> },
	env: Record<string, string | undefined>,
) {
	if (!result.options) return

	switch (providerID) {
		case "openrouter":
		case "vercel":
		case "zenmux":
			result.options.headers = { ...result.options.headers, ...DEFAULT_HEADERS }
			break
		case "cerebras":
			result.options.headers = {
				...result.options.headers,
				"X-Cerebras-3rd-Party-Integration": "kilo",
			}
			break
		case "azure": {
			// Extend env var lookup for Azure baseURL / resource name
			const url = result.options.baseURL ?? env["AZURE_OPENAI_ENDPOINT"]
			const resource = (() => {
				const name = result.options.resourceName
				if (typeof name === "string" && name.trim() !== "") return name
				return env["AZURE_RESOURCE_NAME"] ?? env["AZURE_OPENAI_RESOURCE_NAME"]
			})()
			if (url) {
				result.options.baseURL = url
				delete result.options.resourceName
			} else if (resource) {
				result.options.resourceName = resource
				delete result.options.baseURL
			}
			break
		}
		// gitlab User-Agent and cloudflare error message are patched inline
		// in provider.ts with single-line kilocode_change markers
	}
}

// ---------------------------------------------------------------------------
// getSmallModel helpers
// ---------------------------------------------------------------------------

export function kiloSmallModelPriority(providerID: string): string[] | undefined {
	if (providerID.startsWith("kilo")) return ["kilo-auto/small"]
	return undefined
}

// ---------------------------------------------------------------------------
// Fetch timeout wrapper
// Replaces AbortSignal.timeout() with a cancellable setTimeout+AbortController
// so the timer is cleared once response headers arrive. This prevents healthy
// streaming responses from being aborted mid-stream.
// ---------------------------------------------------------------------------

export function buildTimeoutSignal(options: Record<string, any>): {
	signal: AbortSignal | undefined
	clear: () => void
} {
	const ms = options["timeout"] ?? REQUEST_TIMEOUT_MS
	if (ms === false || ms === undefined || ms === null) return { signal: undefined, clear() {} }

	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		ms as number,
	)
	return {
		signal: controller.signal,
		clear() {
			clearTimeout(timer)
		},
	}
}
