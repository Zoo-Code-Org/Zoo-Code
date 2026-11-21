/** Preserve substring matching for custom deployment names on both OpenAI API paths. */
export function isOSeriesModelId(modelId: string): boolean {
	return modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")
}
