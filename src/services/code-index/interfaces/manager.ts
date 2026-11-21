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

export type { IndexingStatus as IndexProgressUpdate, ProviderWaitStatus } from "@roo-code/types"
