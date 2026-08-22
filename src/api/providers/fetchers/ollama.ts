import axios from "axios"
import { ModelInfo, ollamaDefaultModelInfo } from "@roo-code/types"
import { z } from "zod"

const OllamaModelDetailsSchema = z.object({
	family: z.string(),
	families: z.array(z.string()).nullable().optional(),
	format: z.string().optional(),
	parameter_size: z.string(),
	parent_model: z.string().optional(),
	quantization_level: z.string().optional(),
})

const OllamaModelSchema = z.object({
	details: OllamaModelDetailsSchema,
	digest: z.string().optional(),
	model: z.string(),
	modified_at: z.string().optional(),
	name: z.string(),
	size: z.number().optional(),
})

const OllamaModelInfoResponseSchema = z.object({
	modelfile: z.string().optional(),
	parameters: z.string().optional(),
	template: z.string().optional(),
	details: OllamaModelDetailsSchema,
	model_info: z.record(z.string(), z.any()),
	capabilities: z.array(z.string()).optional(),
})

// Reasoning-effort levels a thinking-capable Ollama model advertises. These are
// model-specific, not a single constant: Ollama's generic `think` API documents
// low/medium/high/max (https://docs.ollama.com/capabilities/thinking), but
// gpt-oss only accepts low/medium/high (see https://ollama.com/library/gpt-oss:
// "Easily adjust the reasoning effort (low, medium, high) ..."). Advertising
// "max" for gpt-oss surfaces a choice the model rejects at request time, so the
// fetcher must pick the array per model rather than from the boolean capability.
//
// Whether reasoning can be turned *off* is also model-specific. Ollama's native
// `think` parameter has no string "none" level — disabling thinking is `think:
// false`. Most thinking models (qwen3, deepseek-r1, ...) honor `think: false`,
// but gpt-oss ignores it and always reasons, so it must not advertise a
// "disable"/"None" option. We model off-support explicitly by including the
// "disable" UI sentinel in the capability array for models that honor
// `think: false`, and omitting it for gpt-oss. The shared
// `getReasoningEffortSelection` then respects explicit arrays verbatim (it
// only auto-adds "disable" for `supportsReasoningEffort === true`), so the
// settings page and chat selector render exactly what the model advertises
// without a UI-side "none" prepend.
//
// `getOllamaThinkingEfforts` resolves the advertised levels from model metadata
// when present, falling back to a family-based heuristic. Tests cover both the
// gpt-oss regression (no "max", no "disable") and the default thinking-model
// case (low/medium/high/max plus "disable").
const GPT_OSS_THINKING_EFFORTS = ["low", "medium", "high"] as const
const DEFAULT_THINKING_EFFORTS = ["disable", "low", "medium", "high", "max"] as const

// gpt-oss reports family "gptoss" and architecture "gptoss" in model_info /
// details (Ollama strips the hyphen from the model id "gpt-oss" for these
// fields — see https://ollama.com/library/gpt-oss, which lists arch "gptoss").
// The model id itself keeps the hyphen ("gpt-oss:20b" / "gpt-oss:120b"), so we
// match on the id too. Detect on any of id / family / architecture, comparing
// a hyphen/underscore-normalized form so "gpt-oss", "gptoss", and "gpt_oss" all
// match regardless of which field Ollama populates for a given tag.
function isGptOssModel(rawModel: OllamaModelInfoResponse, modelId?: string): boolean {
	const normalize = (value: unknown): string =>
		typeof value === "string" ? value.toLowerCase().replace(/[-_]/g, "") : ""

	if (normalize(modelId).startsWith("gptoss")) {
		return true
	}

	if (normalize(rawModel.details.family) === "gptoss") {
		return true
	}

	const architecture = rawModel.model_info["general.architecture"]
	if (normalize(architecture) === "gptoss") {
		return true
	}

	return false
}

// Resolve the reasoning-effort levels a thinking-capable Ollama model advertises,
// including the "disable" UI sentinel when the model honors `think: false`.
// gpt-oss only accepts low/medium/high and ignores `think: false`, so it omits
// "disable"; other thinking models (qwen3, etc. on Ollama Cloud) accept the full
// low/medium/high/max set and honor `think: false`, so they include "disable".
// Exported for tests.
export function getOllamaThinkingEfforts(
	rawModel: OllamaModelInfoResponse,
	modelId?: string,
): readonly ("disable" | "low" | "medium" | "high" | "max")[] {
	return isGptOssModel(rawModel, modelId) ? GPT_OSS_THINKING_EFFORTS : DEFAULT_THINKING_EFFORTS
}

const OllamaModelsResponseSchema = z.object({
	models: z.array(OllamaModelSchema),
})

type OllamaModelsResponse = z.infer<typeof OllamaModelsResponseSchema>

type OllamaModelInfoResponse = z.infer<typeof OllamaModelInfoResponseSchema>

export const parseOllamaModel = (rawModel: OllamaModelInfoResponse, modelId?: string): ModelInfo | null => {
	const contextKey = Object.keys(rawModel.model_info).find((k) => k.includes("context_length"))
	const contextWindow =
		contextKey && typeof rawModel.model_info[contextKey] === "number" ? rawModel.model_info[contextKey] : undefined

	// Filter out models that don't support tools. Models without tool capability won't work.
	const supportsTools = rawModel.capabilities?.includes("tools") ?? false
	if (!supportsTools) {
		return null
	}

	const modelInfo: ModelInfo = Object.assign({}, ollamaDefaultModelInfo, {
		description: `Family: ${rawModel.details.family}, Context: ${contextWindow}, Size: ${rawModel.details.parameter_size}`,
		contextWindow: contextWindow || ollamaDefaultModelInfo.contextWindow,
		supportsPromptCache: true,
		supportsImages: rawModel.capabilities?.includes("vision"),
		// maxTokens represents max OUTPUT tokens, not the context window.
		// Setting it to the full contextWindow causes getModelMaxOutputTokens to
		// reserve 20% of the window for output, triggering premature condensing.
		// Inherit the sane default (4096) from ollamaDefaultModelInfo instead.
	})

	// Models that advertise the "thinking" capability expose a native
	// reasoning-effort control. Thinking levels — and whether reasoning can be
	// turned off at all — are model-specific, not a single constant:
	// - gpt-oss accepts only low/medium/high and ignores `think: false`, so it
	//   advertises exactly ["low","medium","high"] (no "max", no "disable").
	// - Other thinking models (qwen3, etc. on Ollama Cloud) accept the full
	//   low/medium/high/max set and honor `think: false`, so they advertise
	//   ["disable","low","medium","high","max"].
	// (see https://docs.ollama.com/capabilities/thinking and
	// https://ollama.com/library/gpt-oss). Including the "disable" UI sentinel
	// explicitly means off-support is part of the capability array the selector
	// respects verbatim, rather than a UI-side "none" prepend that would also
	// offer an un-disableable "None" for gpt-oss.
	if (rawModel.capabilities?.includes("thinking")) {
		modelInfo.supportsReasoningEffort = [...getOllamaThinkingEfforts(rawModel, modelId)]
		modelInfo.reasoningEffort = "medium"
	}

	return modelInfo
}

export async function getOllamaModels(
	baseUrl = "http://localhost:11434",
	apiKey?: string,
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	// clearing the input can leave an empty string; use the default in that case
	baseUrl = baseUrl === "" ? "http://localhost:11434" : baseUrl

	try {
		if (!URL.canParse(baseUrl)) {
			return models
		}

		// Prepare headers with optional API key
		const headers: Record<string, string> = {}
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get<OllamaModelsResponse>(`${baseUrl}/api/tags`, { headers })
		const parsedResponse = OllamaModelsResponseSchema.safeParse(response.data)
		const modelInfoPromises = []

		if (parsedResponse.success) {
			for (const ollamaModel of parsedResponse.data.models) {
				modelInfoPromises.push(
					axios
						.post<OllamaModelInfoResponse>(
							`${baseUrl}/api/show`,
							{
								model: ollamaModel.model,
							},
							{ headers },
						)
						.then((ollamaModelInfo) => {
							const modelInfo = parseOllamaModel(ollamaModelInfo.data, ollamaModel.model)
							// Only include models that support native tools
							if (modelInfo) {
								models[ollamaModel.name] = modelInfo
							}
						})
						// A single failing /api/show request (corrupt model, timeout,
						// server overload, etc.) must not reject the whole Promise.all
						// and wipe out all otherwise healthy models. Log and swallow
						// the individual failure so the remaining models still load.
						.catch((error) => {
							console.error(`Error fetching details for model ${ollamaModel.model}:`, error)
						}),
				)
			}

			await Promise.all(modelInfoPromises)
		} else {
			console.error(`Error parsing Ollama models response: ${JSON.stringify(parsedResponse.error, null, 2)}`)
		}
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Failed connecting to Ollama at ${baseUrl}`)
		} else {
			console.error(
				`Error fetching Ollama models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}

	return models
}
