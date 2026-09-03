import type { ModelInfo } from "../model.js"

export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1"
export const kimiCodeDefaultModelId = "kimi-for-coding"

export const kimiCodeReasoningEfforts = ["low", "high", "max"] as const

const kimiCodeK3ModelIds = new Set(["k3", "k3-256k"])
const kimiCodeK27ModelIds = new Set(["kimi-for-coding", "kimi-for-coding-highspeed"])

export type KimiCodeRequestProtocol = "reasoning-effort" | "thinking"

const kimiCodeBaseModelInfo: ModelInfo = {
	contextWindow: 262_144,
	maxTokens: 131_072,
	supportsImages: false,
	supportsPromptCache: false,
	supportsReasoningEffort: false,
	requiredReasoningEffort: false,
	supportsTemperature: false,
	description: "Kimi Code model for subscription and API-key access.",
}

export function getKimiCodeRequestProtocol(modelId: string): KimiCodeRequestProtocol | undefined {
	if (kimiCodeK3ModelIds.has(modelId)) return "reasoning-effort"
	if (kimiCodeK27ModelIds.has(modelId)) return "thinking"
	return undefined
}

export function getKimiCodeModelInfo(modelId: string): ModelInfo {
	const protocol = getKimiCodeRequestProtocol(modelId)

	if (protocol === "reasoning-effort") {
		return {
			...kimiCodeBaseModelInfo,
			supportsImages: true,
			supportsReasoningEffort: [...kimiCodeReasoningEfforts],
			requiredReasoningEffort: true,
			reasoningEffort: "high",
			preserveReasoning: true,
			description: "Kimi K3 coding model with configurable reasoning effort.",
		}
	}

	if (protocol === "thinking") {
		return {
			...kimiCodeBaseModelInfo,
			supportsImages: true,
			preserveReasoning: true,
			description: "Kimi K2.7 Code model with preserved thinking.",
		}
	}

	return { ...kimiCodeBaseModelInfo }
}

export const kimiCodeDefaultModelInfo = getKimiCodeModelInfo(kimiCodeDefaultModelId)

export const kimiCodeModels = {
	[kimiCodeDefaultModelId]: kimiCodeDefaultModelInfo,
} as const satisfies Record<string, ModelInfo>

export type KimiCodeModelId = keyof typeof kimiCodeModels
