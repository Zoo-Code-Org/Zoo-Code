import { providerIdentifiers } from "./provider-identifiers.js"

/**
 * Image generation model constants
 */

/**
 * API method used for image generation
 */
export type ImageGenerationApiMethod = "chat_completions" | "images_api"

export interface ImageGenerationModel {
	value: string
	label: string
	provider: ImageGenerationProvider
	apiMethod?: ImageGenerationApiMethod
}

export const IMAGE_GENERATION_MODELS: ImageGenerationModel[] = [
	// OpenRouter models
	{
		value: "google/gemini-2.5-flash-image",
		label: "Gemini 2.5 Flash Image",
		provider: providerIdentifiers.openrouter,
	},
	{
		value: "google/gemini-3-pro-image-preview",
		label: "Gemini 3 Pro Image Preview",
		provider: providerIdentifiers.openrouter,
	},
	{ value: "openai/gpt-5-image", label: "GPT-5 Image", provider: providerIdentifiers.openrouter },
	{ value: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini", provider: providerIdentifiers.openrouter },
	{
		value: "black-forest-labs/flux.2-flex",
		label: "Black Forest Labs FLUX.2 Flex",
		provider: providerIdentifiers.openrouter,
	},
	{
		value: "black-forest-labs/flux.2-pro",
		label: "Black Forest Labs FLUX.2 Pro",
		provider: providerIdentifiers.openrouter,
	},
]

/**
 * Get array of model values only (for backend validation)
 */
export const IMAGE_GENERATION_MODEL_IDS = IMAGE_GENERATION_MODELS.map((m) => m.value)

/**
 * Image generation provider type
 */
export type ImageGenerationProvider = typeof providerIdentifiers.openrouter

/**
 * Get the image generation provider with backwards compatibility
 * - If provider is explicitly set, use it
 * - If a model is already configured (existing users), default to "openrouter"
 * - Otherwise default to "openrouter" (new users)
 */
export function getImageGenerationProvider(
	explicitProvider: ImageGenerationProvider | undefined,
	_hasExistingModel: boolean,
): ImageGenerationProvider {
	return explicitProvider !== undefined ? explicitProvider : providerIdentifiers.openrouter
}
