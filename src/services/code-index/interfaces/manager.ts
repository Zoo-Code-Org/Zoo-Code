export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"
export type EmbedderProvider =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "mistral"
	| "vercel-ai-gateway"
	| "bedrock"
	| "openrouter"
	| "semble"

export interface IndexProgressUpdate {
	systemStatus: IndexingState
	message?: string
	processedBlockCount?: number
	totalBlockCount?: number
}
