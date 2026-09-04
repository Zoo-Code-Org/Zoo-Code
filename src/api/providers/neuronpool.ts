import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export function neuronpoolDefaultBaseUrl(): string {
	return ["https://neuronpool.damnknee.workers.dev", "v1"].join("/")
}

export const NEURONPOOL_DEFAULT_BASE_URL = neuronpoolDefaultBaseUrl()

/** Trim trailing slashes without a `/+` regex (CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(url: string): string {
	let end = url.length
	// Stryker disable next-line ConditionalExpression,EqualityOperator: end>0 vs >=0 is equivalent; charCodeAt(-1) is never 47
	while (end > 0 && url.charCodeAt(end - 1) === 47) {
		end -= 1
	}
	return url.slice(0, end)
}

/** Resolve a custom NeuronPool URL. Empty input uses the default; slash-only and non-HTTPS remote URLs are rejected. */
export function resolveNeuronpoolBaseUrl(raw?: string): string {
	const trimmed = typeof raw === "string" ? raw.trim() : ""
	if (trimmed.length === 0) {
		return neuronpoolDefaultBaseUrl()
	}
	const normalized = stripTrailingSlashes(trimmed)
	if (normalized.length === 0) {
		throw new Error("NeuronPool base URL is required")
	}
	let parsed: URL
	try {
		parsed = new URL(normalized)
	} catch {
		throw new Error("NeuronPool base URL is invalid")
	}
	const host = parsed.hostname.toLowerCase()
	// Stryker disable next-line StringLiteral,LogicalOperator: loopback HTTP is an explicit local-dev allowlist
	const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1"
	if (parsed.protocol === "https:") {
		return normalized
	}
	if (parsed.protocol === "http:" && loopback) {
		return normalized
	}
	throw new Error("NeuronPool base URL must use HTTPS")
}

export class NeuronPoolHandler extends BaseOpenAiCompatibleProvider<NeuronPoolModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "NeuronPool",
			baseURL: resolveNeuronpoolBaseUrl(options.neuronpoolBaseUrl),
			apiKey: options.neuronpoolApiKey ?? options.apiKey,
			defaultProviderModelId: neuronpoolDefaultModelId,
			providerModels: neuronpoolModels,
			defaultTemperature: 0,
		})
	}
}
