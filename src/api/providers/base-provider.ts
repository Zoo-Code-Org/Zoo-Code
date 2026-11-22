import { Anthropic } from "@anthropic-ai/sdk"

import { DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS, type ModelInfo } from "@roo-code/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata, ModelCacheScope } from "../index"
import { ApiStream } from "../transform/stream"
import { sanitizeSurrogates, sanitizeSurrogatesDeep } from "../transform/sanitize-surrogates"
import { stripUnsupportedStrictKeywords } from "../transform/strict-tool-schema"
import { countTokens } from "../../utils/countTokens"
import { isMcpTool } from "../../utils/mcp-name"
import { detachOnAbort } from "./utils/abort-signal"
import { getApiRequestTimeout } from "./utils/timeout-config"

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	protected readonly timeoutMs: number = getApiRequestTimeout()

	private catalogFetch?: Promise<void>
	private catalogLoaded = false

	abstract createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	abstract getModel(): { id: string; info: ModelInfo }

	/**
	 * Converts an array of tools to be compatible with OpenAI's strict mode.
	 * Filters for function tools, applies schema conversion to their parameters,
	 * and ensures all tools have consistent strict values.
	 *
	 * Pass strict=false to serve endpoints that reject strict: true (e.g.
	 * strict-unaware OpenAI-compatible proxies): non-MCP tools are then sent
	 * with strict: false and their declared schemas are preserved as-is.
	 */
	protected convertToolsForOpenAI(
		tools: any[] | undefined,
		strict: boolean = DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS,
	): any[] | undefined {
		if (!tools) {
			return undefined
		}

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			// MCP tools use the 'mcp--' prefix - disable strict mode for them
			// to preserve optional parameters from the MCP server schema
			const isMcp = isMcpTool(tool.function.name)

			// Strict mode also rewrites the schema (all properties become
			// required). When disabled, the declared schema is preserved as-is,
			// retaining every original required constraint (e.g. nanogpt).
			const useStrict = !isMcp && strict

			return {
				...tool,
				function: {
					...tool.function,
					// Sanitize lone UTF-16 surrogates: providers validating the JSON body
					// (e.g. DeepSeek) reject the whole request otherwise. See #461.
					name: sanitizeSurrogates(tool.function.name),
					description: sanitizeSurrogates(tool.function.description),
					strict: useStrict,
					parameters: sanitizeSurrogatesDeep(
						useStrict
							? stripUnsupportedStrictKeywords(this.convertToolSchemaForOpenAI(tool.function.parameters))
							: tool.function.parameters,
					),
				},
			}
		})
	}

	/**
	 * Converts tool schemas to be compatible with OpenAI's strict mode by:
	 * - Ensuring all properties are in the required array (strict mode requirement)
	 * - Keeping parameters the schema did not declare required usable: they
	 *   accept null, so the model can still omit them (#547)
	 * - Converting nullable types (["type", "null"]) of declared required
	 *   parameters to non-nullable ("type")
	 * - Adding additionalProperties: false to all object schemas (required by OpenAI Responses API)
	 * - Recursively processing nested objects and arrays
	 *
	 * This matches the behavior of ensureAllRequired in openai-native.ts
	 */
	protected convertToolSchemaForOpenAI(schema: any): any {
		if (!schema || typeof schema !== "object" || schema.type !== "object") {
			return schema
		}

		const result = { ...schema }

		// OpenAI Responses API requires additionalProperties: false on all object schemas
		// Only add if not already set to false (to avoid unnecessary mutations)
		if (result.additionalProperties !== false) {
			result.additionalProperties = false
		}

		if (result.properties) {
			// The declared required set, read before the strict rewrite lists
			// every key. A key outside it stays optional (#547).
			const declaredRequired: unknown[] = Array.isArray(result.required) ? result.required : []
			const allKeys = Object.keys(result.properties)
			// OpenAI strict mode requires ALL properties to be in required array
			result.required = allKeys

			// Recursively process nested objects and convert nullable types
			const newProps = { ...result.properties }
			for (const key of allKeys) {
				const prop = newProps[key]

				// Clone each property before normalizing so strict conversion never
				// mutates caller-owned tool metadata: a later request with strict
				// disabled must still send the declared (nullable) schema.
				if (prop && typeof prop === "object" && !Array.isArray(prop)) {
					const normalizedProp = { ...prop }

					// Strict mode lists every key in required. Keep a key the
					// schema did not declare required usable by making it accept
					// null (#547). A declared required key keeps a value type.
					if (!declaredRequired.includes(key)) {
						if (typeof normalizedProp.type === "string") {
							if (normalizedProp.type !== "null") {
								normalizedProp.type = [normalizedProp.type, "null"]
							}
						} else if (Array.isArray(normalizedProp.type)) {
							const nonNullTypes = normalizedProp.type.filter((t: string) => t !== "null")
							if (nonNullTypes.length > 0) {
								normalizedProp.type = [...nonNullTypes, "null"]
							}
						}
					} else if (Array.isArray(normalizedProp.type) && normalizedProp.type.includes("null")) {
						// Handle nullable types by removing null
						const nonNullTypes = normalizedProp.type.filter((t: string) => t !== "null")
						normalizedProp.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
					}

					// Recursively process nested objects, including nullable ones.
					// The effective type list drives the checks below so a nullable
					// object or array still gets its nested schema normalized.
					const effectiveTypes: unknown[] = Array.isArray(normalizedProp.type)
						? normalizedProp.type
						: typeof normalizedProp.type === "string"
							? [normalizedProp.type]
							: []
					if (effectiveTypes.includes("object")) {
						// Recurse through an object view of the property so the
						// nested schema is normalized while the property keeps
						// its (possibly nullable) declared type.
						const converted = this.convertToolSchemaForOpenAI({ ...normalizedProp, type: "object" })
						converted.type = normalizedProp.type
						newProps[key] = converted
					} else if (effectiveTypes.includes("array") && normalizedProp.items?.type === "object") {
						newProps[key] = {
							...normalizedProp,
							items: this.convertToolSchemaForOpenAI(normalizedProp.items),
						}
					} else {
						newProps[key] = normalizedProp
					}
				}
			}
			result.properties = newProps
		}

		return result
	}

	/**
	 * Default token counting implementation using tiktoken.
	 * Providers can override this to use their native token counting endpoints.
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		if (content.length === 0) {
			return 0
		}

		return countTokens(content, { useWorker: true })
	}

	/**
	 * Default: no special cache scoping. Catalog providers override this.
	 */
	getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: false, authScoped: false }
	}

	/**
	 * Single-flight the one-time catalog load behind ensureModelFetched().
	 *
	 * Semantics mirror RouterProvider.ensureModelFetched():
	 * - concurrent callers share one fetch;
	 * - a load that produced models is never repeated (catalogLoaded);
	 * - a failed load is retried by the next caller (the promise is cleared);
	 * - a load that resolved with an empty catalog is retried too: getModels()
	 *   deliberately does not cache an empty response, so memoizing it here would
	 *   permanently pin the handler to the fallback model info;
	 * - a caller's signal detaches only that caller's wait, never the shared fetch,
	 *   because the fetch is already bounded by modelCache's 15 s single-flight.
	 *
	 * A loader returns `false` when the catalog it assigned is empty. Returning
	 * `void` (or `true`) means the load counts as successful.
	 */
	protected async ensureCatalogLoaded(load: () => Promise<boolean | void>, signal?: AbortSignal): Promise<void> {
		if (this.catalogLoaded) return
		if (signal?.aborted) throw signal.reason

		this.catalogFetch ??= load()
			.then((hasCatalog) => {
				this.catalogLoaded = hasCatalog !== false
			})
			.finally(() => {
				this.catalogFetch = undefined
			})

		const fetch = this.catalogFetch

		if (!signal) {
			await fetch
			return
		}

		// Detach this waiter as soon as the signal aborts; the shared in-flight
		// fetch continues for any other waiter and still populates the cache.
		await detachOnAbort(fetch, signal)
	}
}
