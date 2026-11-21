import axios from "axios"
import { z } from "zod"

import { type ModelInfo, lMStudioDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import { isTimeoutAbort, mergeAbortSignalAndTimeout, settleOnAbort, throwIfAborted } from "../utils/abort-signal"
import { getLoggableOrigin } from "../utils/endpoint-origin"
import { normalizeLMStudioBaseUrl } from "../utils/lmstudio"

import type { ApiHandler } from "../../index"

import { flushModels, MODEL_CATALOG_FETCH_TIMEOUT_MS } from "./modelCache"

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

// Loading large model files can take minutes; discovery keeps its shorter deadline.
export const LM_STUDIO_MODEL_LOAD_TIMEOUT_MS = 10 * 60_000
const modelsWithLoadedDetails = new Map<string, Set<string>>()
const serverVersions = new Map<string, "v1" | "v0" | "openai">()
type PendingLoad = { promise: Promise<void>; controller: AbortController; waiters: number }
const pendingLoads = new Map<string, PendingLoad>()
// Runtime aliases support saved selections without adding entries to model dropdowns.
const instanceAliases = new Map<string, Map<string, ModelInfo>>()
// A refresh that started earlier must not replace a newer result (LmStudioLoad.tla, FreshWins).
let lastTicket = 0
const settledTickets = new Map<string, number>()
const settleRefresh = (baseUrl: string, ticket: number): boolean =>
	ticket > (settledTickets.get(baseUrl) ?? 0) && !!settledTickets.set(baseUrl, ticket)

export const getLMStudioModelAlias = (modelId: string, baseUrl?: string): ModelInfo | undefined =>
	instanceAliases.get(normalizeLMStudioBaseUrl(baseUrl))?.get(modelId)

export const hasLoadedFullDetails = (modelId: string, baseUrl?: string): boolean =>
	modelsWithLoadedDetails.get(normalizeLMStudioBaseUrl(baseUrl))?.has(modelId) ?? false

const isUnsupportedEndpoint = (error: unknown): boolean =>
	axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 405)

// Older APIs may return HTTP 200 with an error string for an unsupported route.
const errorBodySchema = z.object({ error: z.string() })

type Discovery =
	| { version: "v1"; models: NativeModel[] }
	| { version: "v0"; models: z.infer<typeof legacyListSchema>["data"] }
	| { version: "openai"; models: z.infer<typeof openAIListSchema>["data"] }

type Parsed = { result: Discovery } | { error: Error }
const endpoint = <T>(
	path: string,
	schema: z.ZodType<T>,
	toResult: (data: T, baseUrl: string) => Discovery,
	fallbackNote?: string,
) => ({
	path,
	fallbackNote,
	parse(data: unknown, baseUrl: string): Parsed {
		const parsed = schema.safeParse(data)
		return parsed.success ? { result: toResult(parsed.data, baseUrl) } : { error: parsed.error }
	},
})

// Tried in order (LmStudioDiscovery.tla, endpoints 1 to 3).
const discoveryEndpoints = [
	endpoint("/api/v1/models", nativeListSchema, ({ models: entries }, baseUrl) => {
		const models = entries.flatMap((entry) => {
			const parsed = nativeModelSchema.safeParse(entry)
			return parsed.success ? [parsed.data] : []
		})
		const dropped = entries.length - models.length
		if (dropped)
			console.warn(`LM Studio at ${getLoggableOrigin(baseUrl)} dropped ${dropped} invalid catalog entries`)
		return { version: "v1", models }
	}),
	endpoint(
		"/api/v0/models",
		legacyListSchema,
		({ data }) => ({ version: "v0", models: data }),
		"falling back to /api/v0/models",
	),
	endpoint(
		"/v1/models",
		openAIListSchema,
		({ data }) => ({ version: "openai", models: data }),
		"falling back to OpenAI-compatible discovery without vision or context metadata",
	),
]

async function discoverModels(baseUrl: string, externalSignal?: AbortSignal): Promise<Discovery> {
	const signal = mergeAbortSignalAndTimeout(externalSignal, MODEL_CATALOG_FETCH_TIMEOUT_MS)
	let firstServerError: Error | undefined
	for (const [index, { path, fallbackNote, parse }] of discoveryEndpoints.entries()) {
		const last = index === discoveryEndpoints.length - 1
		if (fallbackNote) console.warn(`LM Studio at ${getLoggableOrigin(baseUrl)} ${fallbackNote}`)
		try {
			const { data } = await axios.get<unknown>(`${baseUrl}${path}`, { signal })
			const parsed = parse(data, baseUrl)
			if ("result" in parsed) return parsed.result
			// Older APIs may return HTTP 200 with an error string for an unsupported route.
			const serverError = errorBodySchema.safeParse(data)
			if (!serverError.success) throw last ? (firstServerError ?? parsed.error) : parsed.error
			firstServerError ??= new Error(serverError.data.error)
			if (last) throw firstServerError
		} catch (error) {
			if (isTimeoutAbort(signal)) throw new Error("LM Studio model discovery timed out")
			throwIfAborted(signal)
			if (!isUnsupportedEndpoint(error)) throw error
			// Keep the earlier server message only when the last endpoint is also unsupported.
			if (last) throw firstServerError ?? error
		}
	}
	throw new Error("unreachable")
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
		console.error(
			`Error ${action} LMStudio models at ${getLoggableOrigin(baseUrl)}:`,
			axios.isAxiosError(error)
				? `${error.message} (status=${error.response?.status ?? "none"}, code=${error.code ?? "none"})`
				: error instanceof Error
					? error.message
					: String(error),
		)
	}
}

export const forceFullModelDetailsLoad = async (
	baseUrl: string | undefined,
	modelId: string,
	handler: ApiHandler,
	signal?: AbortSignal,
): Promise<void> => {
	baseUrl = normalizeLMStudioBaseUrl(baseUrl)
	try {
		throwIfAborted(signal)
		const version = serverVersions.get(baseUrl)
		if (version && version !== "v1") return
		// Acquire the slot before discovery so a late catalog response cannot start
		// another load after an earlier caller has finished. An unloaded model can
		// only resolve by its catalog key; instance aliases already imply a load.
		const loadKey = JSON.stringify([baseUrl, modelId])
		let pending = pendingLoads.get(loadKey)
		if (!pending) {
			const controller = new AbortController()
			const loadSignal = controller.signal
			const promise = (async () => {
				const catalog = await discoverModels(baseUrl, loadSignal)
				throwIfAborted(loadSignal)
				serverVersions.set(baseUrl, catalog.version)
				// Older HTTP APIs leave loading to chat/JIT.
				if (catalog.version !== "v1") return
				const llms = catalog.models.filter(({ type }) => type === "llm")
				const model =
					llms.find(({ key }) => key === modelId) ??
					llms.find(({ loaded_instances }) => loaded_instances.some(({ id }) => id === modelId))
				// Preserve unmatched SDK paths for chat rather than guessing a key.
				if (!model) return
				if (!selectInstance(model, modelId)) {
					console.info(`LM Studio model load started at ${getLoggableOrigin(baseUrl)}`)
					await axios.post(
						`${baseUrl}/api/v1/models/load`,
						{ model: model.key },
						{
							signal: mergeAbortSignalAndTimeout(loadSignal, LM_STUDIO_MODEL_LOAD_TIMEOUT_MS),
						},
					)
					console.info(`LM Studio model load completed at ${getLoggableOrigin(baseUrl)}`)
				}
				throwIfAborted(loadSignal)
				await flushModels(
					{ provider: providerIdentifiers.lmstudio, baseUrl, signal: loadSignal },
					handler,
					true,
				)
			})().finally(() => {
				if (pendingLoads.get(loadKey)?.promise === promise) pendingLoads.delete(loadKey)
			})
			pending = { promise, controller, waiters: 0 }
			pendingLoads.set(loadKey, pending)
		}
		pending.waiters++
		try {
			await settleOnAbort(pending.promise, signal, "LM Studio")
		} finally {
			pending.waiters--
			if (pending.waiters === 0) {
				pending.controller.abort()
				if (pendingLoads.get(loadKey) === pending) pendingLoads.delete(loadKey)
			}
		}
	} catch (error) {
		logModelError("refreshing", error, baseUrl)
	}
}

export async function getLMStudioModels(
	baseUrl?: string,
	opts?: { signal?: AbortSignal; commit?: boolean },
): Promise<Record<string, ModelInfo>> {
	baseUrl = normalizeLMStudioBaseUrl(baseUrl)
	const models = Object.create(null) as Record<string, ModelInfo>
	const loadedDetails = new Set<string>()
	const aliases = new Map<string, ModelInfo>()
	const ticket = ++lastTicket
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
					if (!Object.hasOwn(models, instance.id))
						aliases.set(instance.id, parseLMStudioModel(model, instance.id))
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
				models[model.id] = { ...lMStudioDefaultModelInfo, description: model.id, supportsImages: false }
		}
		if (opts?.commit !== false && settleRefresh(baseUrl, ticket)) {
			serverVersions.set(baseUrl, catalog.version)
			modelsWithLoadedDetails.set(baseUrl, loadedDetails)
			instanceAliases.set(baseUrl, aliases)
		}
	} catch (error) {
		if (!isTimeoutAbort(opts?.signal)) throwIfAborted(opts?.signal)
		if (opts?.commit !== false && settleRefresh(baseUrl, ticket)) {
			serverVersions.delete(baseUrl)
			modelsWithLoadedDetails.delete(baseUrl)
			instanceAliases.delete(baseUrl)
		}
		logModelError("fetching", error, baseUrl)
	}
	return models
}
