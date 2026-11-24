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
	 * Evaluates whether one combinator alternative (an anyOf/oneOf entry)
	 * accepts null, applying the alternative's sibling constraints together
	 * (Draft 2020-12): a type constraint must admit null AND an enum
	 * constraint, when present, must include null (#547 review).
	 */
	private static schemaAlternativeAcceptsNull(alt: unknown): boolean {
		if (alt === true) {
			return true
		}
		if (typeof alt !== "object" || alt === null) {
			return false
		}
		const alternative = alt as Record<string, unknown>

		if (alternative.type !== undefined) {
			const types = Array.isArray(alternative.type) ? alternative.type : [alternative.type]
			if (!types.includes("null")) {
				return false
			}
		}

		// Sibling constraints apply together (Draft 2020-12): the alternative
		// accepts null only when EVERY present constraint admits it — the
		// type list, the enum, and a nested combinator wrapper, which
		// recursively admits null exactly when one of its own alternatives
		// does (#2653 review 4674816413: {anyOf:[{anyOf:[...]}]} must not
		// report acceptance because the wrapper alone has no type/enum).
		let accepts = true

		if (alternative.type !== undefined) {
			const types = Array.isArray(alternative.type) ? alternative.type : [alternative.type]
			if (!types.includes("null")) {
				accepts = false
			}
		}

		if (Array.isArray(alternative.enum) && !alternative.enum.includes(null)) {
			accepts = false
		}

		const nestedCombinator = Array.isArray(alternative.anyOf)
			? alternative.anyOf
			: Array.isArray(alternative.oneOf)
				? alternative.oneOf
				: undefined
		if (nestedCombinator) {
			accepts =
				accepts &&
				(nestedCombinator as unknown[]).some((nested) => BaseProvider.schemaAlternativeAcceptsNull(nested))
		}

		return accepts
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
					let normalizedProp: Record<string, unknown> = { ...(prop as Record<string, unknown>) }

					// Strict mode lists every key in required. Keep a key the
					// schema did not declare required usable by making it accept
					// null (#547). A declared required key keeps a value type.
					if (!declaredRequired.includes(key)) {
						if (typeof normalizedProp.type === "string") {
							if (normalizedProp.type !== "null") {
								normalizedProp.type = [normalizedProp.type, "null"]
							}
						} else if (Array.isArray(normalizedProp.type)) {
							const nonNullTypes = (normalizedProp.type as string[]).filter((t: string) => t !== "null")
							if (nonNullTypes.length > 0) {
								normalizedProp.type = [...nonNullTypes, "null"]
							}
						}
						// A composed schema accepts null only when its
						// combinator does — and a combinator applies
						// alongside any top-level type, because sibling
						// constraints apply together (Draft 2020-12, #547
						// review). Decide by evaluating null against each
						// alternative: an alternative accepts null when its
						// type admits null AND its enum (if any) includes
						// null. Inspecting an alternative's type alone gets
						// both directions wrong: {type:["string","null"],
						// enum:["read"]} rejects null via the enum, while
						// {enum:["read",null]} accepts null with no type.
						// Both combinators are normalized when both are
						// present, because each must accept null on its own.
						let wrappedForOneOf = false
						for (const combinator of ["anyOf", "oneOf"] as const) {
							if (wrappedForOneOf) {
								break
							}
							if (!Array.isArray(normalizedProp[combinator])) {
								continue
							}
							const alternatives = normalizedProp[combinator] as unknown[]
							const nullAccepting = alternatives.filter((alt) =>
								BaseProvider.schemaAlternativeAcceptsNull(alt),
							)
							if (nullAccepting.length === 0) {
								// No alternative admits null: append one. For
								// oneOf the appended alternative is the only
								// null match, so exactly-one semantics hold.
								normalizedProp[combinator] = [...alternatives, { type: "null" }]
							} else if (combinator === "oneOf" && nullAccepting.length > 1) {
								// Multiple alternatives already accept null:
								// strict oneOf would reject null (exactly-one).
								// Wrap the whole property in an outer anyOf with
								// a null alternative instead — valid non-null
								// values still match the original exactly once,
								// and null matches only the outer alternative
								// (review 4674816421).
								const original = normalizedProp
								normalizedProp = { anyOf: [original, { type: "null" }] }
								wrappedForOneOf = true
							}
							// When a single alternative already accepts null,
							// nothing is appended: for oneOf, a second null
							// alternative would make null match twice and fail
							// the exactly-one rule.
						}
						// An enum rejects every value outside its list, so a
						// "null" type alone still rejects null. Include null in
						// the enum of an originally optional property; declared
						// required enums stay unchanged (#547). A wrapped
						// property skips this: the original keeps its declared
						// enum and null is accepted through the outer
						// alternative.
						if (
							!wrappedForOneOf &&
							Array.isArray(normalizedProp.enum) &&
							!normalizedProp.enum.includes(null)
						) {
							normalizedProp.enum = [...normalizedProp.enum, null]
						}
					} else if (
						Array.isArray(normalizedProp.type) &&
						(normalizedProp.type as string[]).includes("null")
					) {
						// Handle nullable types by removing null
						const nonNullTypes = (normalizedProp.type as string[]).filter((t: string) => t !== "null")
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
					} else if (
						effectiveTypes.includes("array") &&
						(normalizedProp as { items?: { type?: unknown } }).items?.type === "object"
					) {
						newProps[key] = {
							...normalizedProp,
							items: this.convertToolSchemaForOpenAI((normalizedProp as { items?: unknown }).items),
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
