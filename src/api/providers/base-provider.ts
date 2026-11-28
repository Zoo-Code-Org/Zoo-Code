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

// Literal-valued keywords carry instance data: a "$ref"-shaped string inside
// them is a value a caller asserts against, never a document location, so
// the wrapped-property reference rewrite leaves them verbatim.
const WRAP_LITERAL_KEYWORDS = new Set(["const", "enum", "default", "examples"])

/**
 * Rewrites local pointers that name a wrapped property's pre-wrap location.
 * When an optional property moves under `anyOf/0`, every sibling reference
 * like "#/properties/value/properties/limit" must follow the subtree to
 * "#/properties/value/anyOf/0/properties/limit", or the pointer would name
 * a location the emitted schema does not have (review 4725679688). Matching
 * is segment-boundary exact, so a property named "value" does not rewrite a
 * pointer into "valueMeta", and pointers to unrelocated properties stay
 * verbatim.
 */
function rewriteWrappedPropertyRefs(node: unknown, wrappedKeys: Map<string, string>): unknown {
	if (Array.isArray(node)) {
		return node.map((entry) => rewriteWrappedPropertyRefs(entry, wrappedKeys))
	}
	if (!node || typeof node !== "object") {
		return node
	}
	const record = node as Record<string, unknown>
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(record)) {
		if (WRAP_LITERAL_KEYWORDS.has(key)) {
			result[key] = value
			continue
		}
		if (key === "$ref" && typeof value === "string") {
			let ref = value
			const sorted = [...wrappedKeys.entries()].sort((a, b) => b[1].length - a[1].length)
			for (const [wrappedKey, oldPrefix] of sorted) {
				if (ref === oldPrefix || ref.startsWith(`${oldPrefix}/`)) {
					ref = `#/properties/${wrappedKey}/anyOf/0${ref.slice(oldPrefix.length)}`
				}
			}
			result[key] = ref
			continue
		}
		result[key] = rewriteWrappedPropertyRefs(value, wrappedKeys)
	}
	return result
}

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

		// A nested combinator is evaluated with its own semantics (a sibling
		// constraint applies under its own combining rule): anyOf accepts
		// null when ANY nested alternative accepts it, while oneOf requires
		// EXACTLY ONE — two nested null-accepting alternatives make the
		// nested oneOf reject null, and reporting acceptance there would
		// leave the emitted schema rejecting null (#2653 review 4675120035).
		for (const combinator of ["anyOf", "oneOf"] as const) {
			if (!Array.isArray(alternative[combinator])) {
				continue
			}
			const acceptingCount = (alternative[combinator] as unknown[]).filter((nested) =>
				BaseProvider.schemaAlternativeAcceptsNull(nested),
			).length
			accepts = accepts && (combinator === "oneOf" ? acceptingCount === 1 : acceptingCount > 0)
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
			// Optional properties that were wrapped in an outer anyOf (a
			// multi-match oneOf or an allOf conjunct beside a nullable type):
			// their subtree moved under anyOf/0, and sibling references that
			// name the pre-wrap location must follow (review 4725679688).
			const wrappedKeys = new Map<string, string>()
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
								// The wrapper leaves no effective type, so the
								// object recursion below cannot reach the
								// original — normalize its own object shape
								// here (review 4675158952): an object-typed
								// original gets the strict constraints before
								// the wrap, with or without declared properties
								// (review 6084531532), because strict mode
								// requires additionalProperties: false on every
								// object schema.
								const originalTypes: unknown[] = Array.isArray(original.type)
									? original.type
									: // Stryker disable next-line ArrayDeclaration: equivalence - the wrap branch is reachable only for optional properties, whose string type was already widened to a type array above, so the fallback never holds "object"/"array" and only feeds those includes checks
										[original.type]
								if (originalTypes.includes("object")) {
									const converted = this.convertToolSchemaForOpenAI({ ...original, type: "object" })
									// Keep the original's declared (possibly
									// nullable) type.
									converted.type = original.type
									normalizedProp = { anyOf: [converted, { type: "null" }] }
									wrappedKeys.set(key, `#/properties/${key}`)
								} else if (
									originalTypes.includes("array") &&
									(original as { items?: { type?: unknown } }).items?.type === "object"
								) {
									// The wrapper leaves no effective type for the
									// recursion below, so the items object never
									// reaches the array-item normalization — convert
									// it here (review 4675584064). The declared
									// (possibly nullable) array type is kept, and
									// null stays accepted through the outer
									// alternative.
									normalizedProp = {
										anyOf: [
											{
												...original,
												items: this.convertToolSchemaForOpenAI(
													(original as { items: unknown }).items,
												),
											},
											{ type: "null" },
										],
									}
									wrappedKeys.set(key, `#/properties/${key}`)
								} else {
									normalizedProp = { anyOf: [original, { type: "null" }] }
								}
								// Stryker disable next-line BooleanLiteral: after the wrap normalizedProp is a fresh anyOf wrapper without an enum, so the flag never changes the enum decision below
								wrappedForOneOf = true
							}
							// When a single alternative already accepts null,
							// nothing is appended: for oneOf, a second null
							// alternative would make null match twice and fail
							// the exactly-one rule.
						}
						// An optional property can also carry an allOf conjunct:
						// null must satisfy the COMPLETE normalized property,
						// and sibling constraints apply together - a nullable
						// type beside a string-only allOf still rejects null
						// (review 4725679687). The wrap mirrors the oneOf
						// route: the original's inner object or array shape
						// is normalized BEFORE the wrap, because the wrapper
						// hides the effective type from the recursion below
						// (reviews 4675158952, 4675584064). A wrapped property
						// skips the enum append below: the original keeps its
						// declared enum and null is accepted through the
						// outer alternative.
						if (
							!wrappedForOneOf &&
							Array.isArray(normalizedProp.allOf) &&
							normalizedProp.allOf.length > 0
						) {
							const declaredType: unknown[] = Array.isArray(normalizedProp.type)
								? normalizedProp.type
								: [normalizedProp.type]
							if (declaredType.includes("object")) {
								const converted = this.convertToolSchemaForOpenAI({ ...normalizedProp, type: "object" })
								converted.type = normalizedProp.type
								normalizedProp = { anyOf: [converted, { type: "null" }] }
							} else if (
								declaredType.includes("array") &&
								(normalizedProp as { items?: { type?: unknown } }).items?.type === "object"
							) {
								normalizedProp = {
									anyOf: [
										{
											...normalizedProp,
											items: this.convertToolSchemaForOpenAI(
												(normalizedProp as { items: unknown }).items,
											),
										},
										{ type: "null" },
									],
								}
							} else {
								normalizedProp = { anyOf: [normalizedProp, { type: "null" }] }
							}
							wrappedForOneOf = true
							wrappedKeys.set(key, `#/properties/${key}`)
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
						: // Stryker disable next-line ConditionalExpression: only the true-arm mutant is equivalent - a non-array, non-string type never equals "object"/"array", so [value] and [] pick the same branch below; the false-arm is killed by the declared-required object test
							typeof normalizedProp.type === "string"
							? [normalizedProp.type]
							: // Stryker disable next-line ArrayDeclaration: the fallback only feeds the includes("object")/includes("array") checks, and no non-type string can flip either
								[]
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
			// A wrapped property's subtree moved under anyOf/0: a pointer
			// from a sibling property that names the pre-wrap location
			// would dangle (review 4725679688). The pointers follow the
			// subtree to its new location; every pointer that does not
			// name a wrapped property stays verbatim.
			if (wrappedKeys.size > 0) {
				for (const [propKey, propSchema] of Object.entries(newProps)) {
					newProps[propKey] = rewriteWrappedPropertyRefs(propSchema, wrappedKeys)
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
