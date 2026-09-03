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

const OllamaModelsResponseSchema = z.object({
	models: z.array(OllamaModelSchema),
})

type OllamaModelsResponse = z.infer<typeof OllamaModelsResponseSchema>

type OllamaModelInfoResponse = z.infer<typeof OllamaModelInfoResponseSchema>

export const parseOllamaModel = (rawModel: OllamaModelInfoResponse): ModelInfo | null => {
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

	return modelInfo
}

/**
 * Determines whether an Ollama endpoint is safe to carry an API key.
 *
 * Ollama's default installation listens on loopback, where plaintext HTTP is
 * the norm. API keys are secrets, though, and must not be sent in cleartext to
 * a remote host (CWE-319). Only HTTPS or a loopback host is considered safe
 * enough to attach the Authorization header.
 */
export function isSecureOllamaEndpoint(baseUrl: string): boolean {
	if (!URL.canParse(baseUrl)) {
		return false
	}
	const url = new URL(baseUrl)
	if (url.protocol === "https:") {
		return true
	}
	const host = url.hostname
	return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host)
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

		// Prepare headers with optional API key. The credential is only attached
		// when the endpoint is HTTPS or loopback; sending it over plaintext HTTP
		// to a remote host would leak it (CWE-319).
		const credentialGated = Boolean(apiKey && isSecureOllamaEndpoint(baseUrl))
		const headers: Record<string, string> = {}
		if (credentialGated) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		// A loopback HTTP endpoint carrying the key must bypass any HTTP proxy,
		// otherwise the proxy would see the bearer token in cleartext (CWE-319).
		// HTTPS endpoints keep normal proxy behavior (traffic stays encrypted).
		// Parsing is safe here: baseUrl is normalized ("" → default) above and
		// the !URL.canParse(baseUrl) guard returned early.
		const cleartextLoopback = credentialGated && new URL(baseUrl).protocol === "http:"
		const proxyConfig: { proxy?: false } = cleartextLoopback ? { proxy: false } : {}

		const response = await axios.get<OllamaModelsResponse>(`${baseUrl}/api/tags`, { headers, ...proxyConfig })
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
							{ headers, ...proxyConfig },
						)
						.then((ollamaModelInfo) => {
							const modelInfo = parseOllamaModel(ollamaModelInfo.data)
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
