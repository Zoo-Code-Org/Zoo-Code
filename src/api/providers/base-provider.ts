import { Anthropic } from "@anthropic-ai/sdk"

import { DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS, type ModelInfo } from "@roo-code/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { ApiStream } from "../transform/stream"
import { countTokens } from "../../utils/countTokens"
import { isMcpTool } from "../../utils/mcp-name"
import { getApiRequestTimeout } from "./utils/timeout-config"

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	protected readonly timeoutMs: number = getApiRequestTimeout()

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
					strict: useStrict,
					parameters: useStrict
						? this.convertToolSchemaForOpenAI(tool.function.parameters)
						: tool.function.parameters,
				},
			}
		})
	}

	/**
	 * Converts tool schemas to be compatible with OpenAI's strict mode by:
	 * - Ensuring all properties are in the required array (strict mode requirement)
	 * - Converting nullable types (["type", "null"]) to non-nullable ("type")
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

					// Handle nullable types by removing null
					if (Array.isArray(normalizedProp.type) && normalizedProp.type.includes("null")) {
						const nonNullTypes = normalizedProp.type.filter((t: string) => t !== "null")
						normalizedProp.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
					}

					// Recursively process nested objects
					if (normalizedProp.type === "object") {
						newProps[key] = this.convertToolSchemaForOpenAI(normalizedProp)
					} else if (normalizedProp.type === "array" && normalizedProp.items?.type === "object") {
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
}
