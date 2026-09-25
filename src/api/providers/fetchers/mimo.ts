import type { ModelRecord } from "@roo-code/types"
import { mimoModels } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

// The /models endpoint also lists ASR/TTS families, which are not text chat
// models — they require modality-specific payloads this provider never
// builds, so discovery excludes them from the catalog.
const NON_TEXT_MODEL_ID = /-(asr|tts)(-|$)/i

// Network-boundary allowlist: the same four Xiaomi MiMo endpoints the persisted
// settings schema validates `mimoBaseUrl` against via a zod union of literals
// (packages/types/src/provider-settings/mimo.ts). The definition itself is not
// re-exported through the @roo-code/types public entry points, so the literals
// are mirrored here; __tests__/mimo.spec.ts cross-checks this exported set
// against providerSettingsSchema so the two sources cannot silently drift. The
// fetcher also receives unsaved webview values that bypass the schema entirely,
// so this exact-match gate is the only thing guaranteeing the bearer key never
// leaves a Xiaomi origin. Exported for that drift test only.
export const ALLOWED_BASE_URLS: ReadonlySet<string> = new Set([
	"https://api.xiaomimimo.com/v1",
	"https://token-plan-cn.xiaomimimo.com/v1",
	"https://token-plan-sgp.xiaomimimo.com/v1",
	"https://token-plan-ams.xiaomimimo.com/v1",
])

// True when the authority component carries `user[:pass]@` credentials. Input
// without a `scheme://` prefix is treated as bare authority so credential-like
// strings cannot slip past the userinfo check into the allowlist rejection
// below. Rejection messages never echo the input: query strings and fragments
// can also carry secrets and are not visible to this authority-only check.
function containsUserinfo(rawUrl: string): boolean {
	const schemeEnd = rawUrl.indexOf("://")
	const rest = schemeEnd === -1 ? rawUrl : rawUrl.slice(schemeEnd + 3)
	const authority = rest.split(/[/?#]/)[0]
	return authority.includes("@")
}

/**
 * Fetches available models from the Xiaomi MiMo API and merges them with known specs.
 *
 * MiMo's OpenAI-compatible /models endpoint only returns basic model IDs without
 * pricing or context window info, so we merge the API response with the static
 * `mimoModels` map for known models. Unknown models get MiMo-family defaults with
 * `preserveReasoning` enabled — MiMo requires reasoning_content to be passed back
 * in multi-turn tool-calling conversations, so reasoning preservation is a
 * correctness requirement, not an optimization.
 */
export async function getMimoModels(
	baseUrl?: string,
	apiKey?: string,
	opts?: { signal?: AbortSignal },
): Promise<ModelRecord> {
	// MiMo API uses OpenAI-compatible /v1/models endpoint.
	// The base URL from settings already includes /v1 (e.g. https://token-plan-sgp.xiaomimimo.com/v1),
	// so we keep it as-is and append /models directly.
	const base = (baseUrl || "https://token-plan-sgp.xiaomimimo.com/v1").replace(/\/+$/, "")

	// Reject embedded credentials first, then pin the request to the four allowed
	// endpoints with an exact match. This subsumes the previous https-only guard
	// (every allowed URL is https, so plaintext HTTP, arbitrary hosts, and path
	// tricks all fail the allowlist) and runs before any header is built, so a
	// partial or off-list request is never sent. Rejection errors are constant
	// strings: the raw URL is never echoed because query strings and fragments
	// can carry secrets too.
	if (containsUserinfo(base)) {
		throw new Error("MIMO/getMimoModels/001: MiMo model fetch rejected: base URL must not contain credentials.")
	}
	if (!ALLOWED_BASE_URLS.has(base)) {
		throw new Error(
			"MIMO/getMimoModels/002: MiMo model fetch rejected: base URL is not an allowed Xiaomi MiMo endpoint.",
		)
	}

	const url = new URL(`${base}/models`)

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`
	}

	const response = await fetch(url.toString(), {
		headers,
		signal: opts?.signal,
	})

	if (!response.ok) {
		let errorBody = ""
		try {
			errorBody = await response.text()
		} catch {
			errorBody = "(unable to read response body)"
		}

		console.error(`[getMimoModels] HTTP error:`, {
			status: response.status,
			statusText: response.statusText,
			url: url.toString(),
			body: errorBody,
		})

		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const data = await response.json()

	if (!data?.data || !Array.isArray(data.data)) {
		console.error("[getMimoModels] Unexpected response format:", data)
		throw new Error("Failed to fetch MiMo models: Unexpected response format.")
	}

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for (const model of data.data) {
		// Skip non-record elements so a single malformed entry cannot abort
		// the whole catalog.
		if (typeof model !== "object" || model === null) continue

		const modelId = typeof model.id === "string" && model.id ? model.id : null
		if (!modelId || NON_TEXT_MODEL_ID.test(modelId)) continue

		const knownSpecs = mimoModels[modelId as keyof typeof mimoModels]

		if (knownSpecs) {
			models[modelId] = { ...knownSpecs }
		} else {
			models[modelId] = {
				maxTokens: 16_000,
				contextWindow: 262_144,
				supportsImages: false,
				supportsPromptCache: false,
				preserveReasoning: true,
				description: `MiMo model: ${modelId}`,
			}
		}
	}

	return models
}
