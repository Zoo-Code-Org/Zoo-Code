import axios from "axios"
import { z } from "zod"

import { type ModelInfo, lMStudioDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import { throwIfAborted } from "../utils/abort-signal"
import { getLoggableOrigin } from "../utils/endpoint-origin"

import type { ApiHandler } from "../../index"

import { flushModels } from "./modelCache"

const contextLengthSchema = z.number().int().positive()
const instanceSchema = z.object({
	id: z.string(),
	config: z.object({ context_length: contextLengthSchema.optional() }),
})
const nativeModelSchema = z.object({
	type: z.string(),
	key: z.string(),
	display_name: z.string().optional(),
	max_context_length: contextLengthSchema.nullish(),
	capabilities: z.object({ vision: z.boolean().optional() }).optional(),
	loaded_instances: z.array(instanceSchema),
})
// Entries are validated one by one, so one unexpected model cannot empty the catalog.
const nativeListSchema = z.object({ models: z.array(z.unknown()) })
const legacyListSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			type: z.string(),
			max_context_length: contextLengthSchema.nullish(),
		}),
	),
})
const openAIListSchema = z.object({ data: z.array(z.object({ id: z.string() })) })

type NativeModel = z.infer<typeof nativeModelSchema>
type Instance = z.infer<typeof instanceSchema>

const normalizeBaseUrl = (baseUrl?: string): string => (baseUrl || "http://localhost:1234").replace(/\/+$/, "")
const modelsWithLoadedDetails = new Map<string, Set<string>>()
const pendingLoads = new Map<string, Promise<void>>()
// Runtime aliases support saved selections without adding entries to model dropdowns.
const instanceAliases = new Map<string, Map<string, ModelInfo>>()

export const getLMStudioModelAlias = (modelId: string, baseUrl?: string): ModelInfo | undefined =>
	instanceAliases.get(normalizeBaseUrl(baseUrl))?.get(modelId)

export const hasLoadedFullDetails = (modelId: string, baseUrl?: string): boolean =>
	modelsWithLoadedDetails.get(normalizeBaseUrl(baseUrl))?.has(modelId) ?? false

const isUnsupportedEndpoint = (error: unknown): boolean =>
	axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 405)

async function discoverModels(baseUrl: string, signal?: AbortSignal) {
	try {
		const { data } = await axios.get<unknown>(`${baseUrl}/api/v1/models`, { signal })
		const models = nativeListSchema.parse(data).models.flatMap((entry) => {
			const parsed = nativeModelSchema.safeParse(entry)
			return parsed.success ? [parsed.data] : []
		})
		return { version: "v1" as const, models }
	} catch (error) {
		throwIfAborted(signal)
		if (!isUnsupportedEndpoint(error)) throw error
	}

	try {
		const { data } = await axios.get<unknown>(`${baseUrl}/api/v0/models`, { signal })
		return { version: "v0" as const, models: legacyListSchema.parse(data).data }
	} catch (error) {
		throwIfAborted(signal)
		if (!isUnsupportedEndpoint(error)) throw error
	}

	const { data } = await axios.get<unknown>(`${baseUrl}/v1/models`, { signal })
	return { version: "openai" as const, models: openAIListSchema.parse(data).data }
}

// Prefer the instance explicitly selected by the user; otherwise use server order.
// Catalog keys identify model files, whereas instance IDs identify runtime configurations.
const selectInstance = (model: NativeModel, savedId: string): Instance | undefined =>
	model.loaded_instances.find(({ id }) => id === savedId) ?? model.loaded_instances[0]

export const parseLMStudioModel = (model: NativeModel, savedId = model.key): ModelInfo => {
	const contextLength = selectInstance(model, savedId)?.config.context_length ?? model.max_context_length
	return {
		...lMStudioDefaultModelInfo,
		description: `${model.display_name ?? model.key} - ${model.key}`,
		supportsImages: model.capabilities?.vision ?? false,
		...(contextLength ? { contextWindow: contextLength, maxTokens: contextLength } : {}),
	}
}

function logModelError(action: string, error: unknown, baseUrl: string) {
	if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
		console.warn(`Error connecting to LMStudio at ${getLoggableOrigin(baseUrl)}`)
	} else {
		console.error(`Error ${action} LMStudio models:`, error instanceof Error ? error.message : String(error))
	}
}

export const forceFullModelDetailsLoad = async (
	baseUrl: string,
	modelId: string,
	handler: ApiHandler,
): Promise<void> => {
	baseUrl = normalizeBaseUrl(baseUrl)
	try {
		// Acquire the slot before discovery so a late catalog response cannot start
		// another load after an earlier caller has finished. An unloaded model can
		// only resolve by its catalog key; instance aliases already imply a load.
		const loadKey = JSON.stringify([baseUrl, modelId])
		let pending = pendingLoads.get(loadKey)
		if (!pending) {
			pending = (async () => {
				const catalog = await discoverModels(baseUrl)
				// Older HTTP APIs leave loading to chat/JIT.
				if (catalog.version !== "v1") return
				const llms = catalog.models.filter(({ type }) => type === "llm")
				const model =
					llms.find(({ key }) => key === modelId) ??
					llms.find(({ loaded_instances }) => loaded_instances.some(({ id }) => id === modelId))
				// Preserve unmatched SDK paths for chat rather than guessing a key.
				if (!model) return
				if (!selectInstance(model, modelId)) {
					await axios.post(`${baseUrl}/api/v1/models/load`, { model: model.key })
				}
				await flushModels({ provider: providerIdentifiers.lmstudio, baseUrl }, handler, true)
			})().finally(() => pendingLoads.delete(loadKey))
			pendingLoads.set(loadKey, pending)
		}
		await pending
	} catch (error) {
		logModelError("refreshing", error, baseUrl)
	}
}

export async function getLMStudioModels(
	baseUrl = "http://localhost:1234",
	opts?: { signal?: AbortSignal },
): Promise<Record<string, ModelInfo>> {
	baseUrl = normalizeBaseUrl(baseUrl)
	const models: Record<string, ModelInfo> = {}
	const loadedDetails = new Set<string>()
	const aliases = new Map<string, ModelInfo>()
	try {
		throwIfAborted(opts?.signal)
		if (!URL.canParse(baseUrl)) return models
		const catalog = await discoverModels(baseUrl, opts?.signal)
		throwIfAborted(opts?.signal)
		if (catalog.version === "v1") {
			for (const model of catalog.models.filter(({ type }) => type === "llm")) {
				models[model.key] = parseLMStudioModel(model)
				if (selectInstance(model, model.key)?.config.context_length) loadedDetails.add(model.key)
			}
			for (const model of catalog.models.filter(({ type }) => type === "llm")) {
				for (const instance of model.loaded_instances) {
					// Exact instance aliases preserve saved custom names and pre-variant IDs.
					if (!(instance.id in models)) aliases.set(instance.id, parseLMStudioModel(model, instance.id))
					if (instance.config.context_length) loadedDetails.add(instance.id)
				}
			}
		} else if (catalog.version === "v0") {
			for (const model of catalog.models.filter(({ type }) => type === "llm" || type === "vlm")) {
				models[model.id] = {
					...lMStudioDefaultModelInfo,
					description: model.id,
					supportsImages: model.type === "vlm",
					...(model.max_context_length
						? { contextWindow: model.max_context_length, maxTokens: model.max_context_length }
						: {}),
				}
			}
		} else {
			// OpenAI-compatible discovery has no type, vision, or context metadata.
			for (const model of catalog.models)
				models[model.id] = { ...lMStudioDefaultModelInfo, description: model.id }
		}
		modelsWithLoadedDetails.set(baseUrl, loadedDetails)
		instanceAliases.set(baseUrl, aliases)
	} catch (error) {
		throwIfAborted(opts?.signal)
		logModelError("fetching", error, baseUrl)
	}
	return models
}
