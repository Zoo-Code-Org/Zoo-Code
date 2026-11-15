import { z } from "zod"

import type { ProviderInfoKind, ProviderInfoParams, ProviderInfoResultMap, WebviewMessage } from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"
import { getOpenRouterModelEndpoints } from "../../api/providers/fetchers/openrouter"
import { toRequestyServiceUrl } from "../../shared/utils/requesty"

const FETCH_TIMEOUT_MS = 10_000
// Far above any real provider response. The cap stops a configured endpoint from filling host memory.
const MAX_BODY_BYTES = 1024 * 1024
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

const openRouterKeyInfoSchema = z.object({
	data: z.object({
		label: z.string(),
		usage: z.number(),
		is_free_tier: z.boolean(),
		is_provisioning_key: z.boolean(),
		rate_limit: z.object({
			requests: z.number(),
			interval: z.string(),
		}),
		limit: z.number().nullable(),
	}),
})

const requestyKeyInfoSchema = z.object({
	name: z.string(),
	monthly_limit: z.string(),
	monthly_spend: z.string(),
	org_balance: z.string(),
	config: z.object({
		aliases: z.record(z.string(), z.any()).optional(),
	}),
})

async function readBoundedText(response: Response): Promise<string> {
	// Count bytes as they arrive. Content-Length can be missing or wrong.
	const reader = response.body?.getReader()
	const chunks: Uint8Array[] = []
	let total = 0

	while (reader) {
		const { done, value } = await reader.read()
		if (done) break

		total += value.byteLength
		if (total > MAX_BODY_BYTES) {
			await reader.cancel()
			throw new Error("Response body too large")
		}
		chunks.push(value)
	}

	return Buffer.concat(chunks).toString("utf8")
}

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, {
		method: "GET",
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})

	if (!response.ok) {
		throw new Error(`Request failed with status code ${response.status}`)
	}

	return JSON.parse(await readBoundedText(response))
}

async function getOpenRouterKeyInfo({ apiKey, baseUrl }: ProviderInfoParams) {
	if (!apiKey) return null

	const body = await getJson(`${baseUrl || OPENROUTER_DEFAULT_BASE_URL}/key`, {
		Authorization: `Bearer ${apiKey}`,
	})
	const result = openRouterKeyInfoSchema.safeParse(body)

	if (!result.success) {
		console.error("OpenRouter API key info validation failed:", result.error)
		return null
	}

	return result.data.data
}

// Reuse the shared fetcher. It returns {} on failure, which the webview treats as no providers.
// The key is the provider label, so the webview select can show it.
async function getOpenRouterModelProviders({ modelId, baseUrl }: ProviderInfoParams) {
	if (!modelId) return {}

	const endpoints = await getOpenRouterModelEndpoints(
		modelId,
		{ openRouterBaseUrl: baseUrl },
		{ untrustedBaseUrl: true },
	)

	return Object.fromEntries(Object.entries(endpoints).map(([label, info]) => [label, { ...info, label }]))
}

async function getRequestyKeyInfo({ apiKey, baseUrl }: ProviderInfoParams) {
	if (!apiKey) return null

	const apiKeyUrl = new URL("x/apikey", toRequestyServiceUrl(baseUrl, "api"))
	const body = await getJson(apiKeyUrl.toString(), {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	})
	const result = requestyKeyInfoSchema.safeParse(body)

	if (!result.success) {
		console.error("Requesty API key info validation failed:", result.error)
		return null
	}

	return result.data
}

const fetchers: { [K in ProviderInfoKind]: (params: ProviderInfoParams) => Promise<ProviderInfoResultMap[K]> } = {
	openRouterKeyInfo: getOpenRouterKeyInfo,
	openRouterModelProviders: getOpenRouterModelProviders,
	requestyKeyInfo: getRequestyKeyInfo,
}

const isProviderInfoKind = (kind: unknown): kind is ProviderInfoKind =>
	typeof kind === "string" && Object.hasOwn(fetchers, kind)

// Non-string params fail the parse, so a bad value never reaches a fetcher.
const providerInfoParamsSchema = z.object({
	apiKey: z.string().optional(),
	baseUrl: z.string().optional(),
	modelId: z.string().optional(),
})

/**
 * Fetch provider key and model info in the extension host so the webview CSP
 * needs no provider origins. The webview sends unsaved settings values, so the
 * handler reads credentials from the message, not from saved config.
 */
export async function handleRequestProviderInfo(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const { kind, ...rawParams } = message.values ?? {}
	const parsed = providerInfoParamsSchema.safeParse(rawParams)

	if (!isProviderInfoKind(kind) || !parsed.success) {
		await provider.postMessageToWebview({
			type: "providerInfo",
			requestId: message.requestId,
			error: "Invalid provider info request",
		})
		return
	}

	try {
		const data = await fetchers[kind](parsed.data)
		await provider.postMessageToWebview({ type: "providerInfo", requestId: message.requestId, values: { data } })
	} catch (error) {
		// Log the kind only. The error text can carry a configured URL.
		provider.log(`Failed to fetch provider info (${kind})`)
		console.error(`Error fetching provider info (${kind}):`, error instanceof Error ? error.name : "unknown")
		await provider.postMessageToWebview({
			type: "providerInfo",
			requestId: message.requestId,
			error: "Provider info request failed",
		})
	}
}
