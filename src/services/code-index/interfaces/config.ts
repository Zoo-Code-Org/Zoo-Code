import { EmbedderProvider } from "./manager"

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
	readonly isConfigured: boolean
	readonly embedderProvider: EmbedderProvider
	readonly modelId?: string
	readonly modelDimension?: number // Generic dimension property for all providers
	readonly openAiOptions?: Readonly<{ openAiNativeApiKey?: string }>
	readonly ollamaOptions?: Readonly<{ ollamaBaseUrl?: string }>
	readonly openAiCompatibleOptions?: Readonly<{ baseUrl: string; apiKey: string }>
	readonly geminiOptions?: Readonly<{ apiKey: string }>
	readonly mistralOptions?: Readonly<{ apiKey: string }>
	readonly vercelAiGatewayOptions?: Readonly<{ apiKey: string }>
	readonly bedrockOptions?: Readonly<{ region: string; profile?: string }>
	readonly openRouterOptions?: Readonly<{ apiKey: string; specificProvider?: string }>
	readonly qdrantUrl?: string
	readonly qdrantApiKey?: string
	readonly searchMinScore?: number
	readonly searchMaxResults?: number
}

/**
 * Stored configuration snapshot. Search defaults and readiness are derived by the manager.
 * Every nested options object contains only scalar values and is readonly as well.
 */
export interface CodeIndexConfigSnapshot extends Omit<CodeIndexConfig, "isConfigured"> {
	readonly codebaseIndexEnabled: boolean
}

/** Freeze the snapshot and its flat options objects before publishing it. */
export function freezeCodeIndexConfigSnapshot(snapshot: CodeIndexConfigSnapshot): CodeIndexConfigSnapshot {
	for (const value of Object.values(snapshot)) {
		if (value !== null && typeof value === "object") {
			Object.freeze(value)
		}
	}
	return Object.freeze(snapshot)
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	readonly enabled: boolean
	readonly configured: boolean
	readonly embedderProvider: EmbedderProvider
	readonly modelId?: string
	readonly modelDimension?: number // Generic dimension property
	readonly openAiKey?: string
	readonly ollamaBaseUrl?: string
	readonly openAiCompatibleBaseUrl?: string
	readonly openAiCompatibleApiKey?: string
	readonly geminiApiKey?: string
	readonly mistralApiKey?: string
	readonly vercelAiGatewayApiKey?: string
	readonly bedrockRegion?: string
	readonly bedrockProfile?: string
	readonly openRouterApiKey?: string
	readonly openRouterSpecificProvider?: string
	readonly qdrantUrl?: string
	readonly qdrantApiKey?: string
}
