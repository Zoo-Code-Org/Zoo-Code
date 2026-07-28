import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

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
	 * Converts an array of tools for OpenAI-compatible providers.
	 * Filters for function tools and applies schema conversion to their parameters.
	 *
	 * When `strictMode` is true, non-MCP function tools get `strict: true` and
	 * their schemas are hardened via `convertToolSchemaForOpenAI()` (adds
	 * `additionalProperties: false`, marks all properties required, etc.).
	 *
	 * When `strictMode` is false (default), non-MCP function tools get
	 * `strict: false` and their original best-effort schemas are preserved
	 * without hardening. This is semantically consistent: `strict: false`
	 * should not imply strict-schema transformations.
	 *
	 * MCP tools are ALWAYS `strict: false` with original parameters preserved,
	 * regardless of the `strictMode` setting, because MCP schemas may contain
	 * optional properties that must remain optional.
	 */
	protected convertToolsForOpenAI(tools: any[] | undefined, strictMode: boolean = false): any[] | undefined {
		if (!tools) {
			return undefined
		}

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			// MCP tools use the 'mcp--' prefix - always disable strict mode
			// to preserve optional parameters from the MCP server schema
			const isMcp = isMcpTool(tool.function.name)

			if (isMcp) {
				return {
					...tool,
					function: {
						...tool.function,
						strict: false,
						parameters: tool.function.parameters,
					},
				}
			}

			// Non-MCP function tools respect the strictMode setting
			if (strictMode) {
				return {
					...tool,
					function: {
						...tool.function,
						strict: true,
						parameters: this.convertToolSchemaForOpenAI(tool.function.parameters),
					},
				}
			}

			// strictMode false: preserve original best-effort schema
			return {
				...tool,
				function: {
					...tool.function,
					strict: false,
					parameters: tool.function.parameters,
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

				// Handle nullable types by removing null
				if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
					const nonNullTypes = prop.type.filter((t: string) => t !== "null")
					prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
				}

				// Recursively process nested objects
				if (prop && prop.type === "object") {
					newProps[key] = this.convertToolSchemaForOpenAI(prop)
				} else if (prop && prop.type === "array" && prop.items?.type === "object") {
					newProps[key] = {
						...prop,
						items: this.convertToolSchemaForOpenAI(prop.items),
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
