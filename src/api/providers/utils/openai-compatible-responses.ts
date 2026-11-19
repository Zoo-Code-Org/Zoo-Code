import type OpenAI from "openai"
import type { ModelInfo } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { OpenAiReasoningParams } from "../../transform/reasoning"
import { convertToResponsesApiInput, type ResponsesApiMessage } from "../../transform/responses-api-input"
import {
	sanitizeSurrogates,
	sanitizeSurrogatesDeep,
	sanitizeIdentifierSurrogates,
} from "../../transform/sanitize-surrogates"

type ResponsesRequestInput = {
	options: Readonly<ApiHandlerOptions>
	modelInfo: ModelInfo
	reasoning: OpenAiReasoningParams | undefined
	systemPrompt: string
	messages: ResponsesApiMessage[]
	metadata?: ApiHandlerCreateMessageMetadata
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined
	extraBody: Readonly<Record<string, unknown>>
}

/** Builds a request from explicit inputs without registering listeners or calling the SDK. */
export function buildResponsesRequest({
	options,
	modelInfo,
	reasoning,
	systemPrompt,
	messages,
	metadata,
	tools,
	extraBody,
}: ResponsesRequestInput): OpenAI.Responses.ResponseCreateParams {
	// Sanitize before conversion, including strings inside JSON tool arguments.
	// Encode IDs first so distinct tool calls remain distinct after sanitization.
	const history = messages.map((message) => {
		if (!("role" in message)) return message
		return {
			...message,
			content:
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => {
							if (part.type === "tool_use") return { ...part, id: sanitizeIdentifierSurrogates(part.id) }
							if (part.type === "tool_result")
								return { ...part, tool_use_id: sanitizeIdentifierSurrogates(part.tool_use_id) }
							return part
						}),
		}
	})
	// The deep sanitizer preserves the message structure and only replaces strings.
	const sanitizedHistory = sanitizeSurrogatesDeep(history) as ResponsesApiMessage[]
	const requestBody: OpenAI.Responses.ResponseCreateParams = {
		model: options.openAiModelId ?? "",
		instructions: sanitizeSurrogates(systemPrompt),
		input: convertToResponsesApiInput(sanitizedHistory),
		stream: options.openAiStreamingEnabled ?? true,
		// Stateless operation: don't store responses server-side.
		store: false,
	}

	// The Responses API takes reasoning as `reasoning: { effort }` instead of
	// the Chat Completions `reasoning_effort` field; translate the resolved
	// params (which honor the custom model info's reasoningEffort) so
	// reasoning and function tools can be combined on this endpoint.
	if (reasoning?.reasoning_effort) {
		requestBody.reasoning = {
			effort: reasoning.reasoning_effort,
		}
		// Only request encrypted reasoning content when reasoning is active.
		if (String(reasoning.reasoning_effort) !== "none") requestBody.include = ["reasoning.encrypted_content"]
	}

	// Mirror the Chat Completions temperature policy: omit it unless the
	// model supports it and the user set a custom value, so the server's own
	// default applies.
	if (modelInfo.supportsTemperature !== false && options.modelTemperature != null) {
		requestBody.temperature = options.modelTemperature
	}

	// Mirror the Chat Completions max-tokens policy: only cap output when the
	// user opted in via includeMaxTokens.
	const maxTokens = options.modelMaxTokens || modelInfo.maxTokens
	if (options.includeMaxTokens === true && maxTokens !== undefined) {
		requestBody.max_output_tokens = maxTokens
	}

	// convertToolsForOpenAI already applies the strict/non-strict schema
	// policy (including the MCP strict exemption); the Responses API only
	// needs the flattened function shape.
	const responseTools = tools
		?.filter((tool) => tool?.type === "function")
		.map((tool) => ({
			type: "function" as const,
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters ?? null,
			strict: tool.function.strict ?? null,
		}))

	if (responseTools?.length) {
		requestBody.tools = responseTools
		if (metadata?.tool_choice) {
			requestBody.tool_choice = mapToolChoiceForResponsesApi(metadata.tool_choice)
		}
		requestBody.parallel_tool_calls = metadata?.parallelToolCalls ?? true
	}
	return { ...extraBody, ...requestBody }
}

/**
 * Maps a Chat Completions tool choice to the Responses API shape. String
 * options (auto/required/none) are identical in both APIs; named-tool
 * choices nest the name under `function`/`custom` in Chat Completions but
 * keep it at the top level in the Responses API. Allowed function references are flattened while retaining their restriction mode.
 */
function mapToolChoiceForResponsesApi(
	toolChoice: NonNullable<OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]>,
): OpenAI.Responses.ResponseCreateParamsStreaming["tool_choice"] {
	if (typeof toolChoice === "string") {
		return toolChoice
	}
	switch (toolChoice.type) {
		case "function":
			return { type: "function", name: toolChoice.function.name }
		case "custom":
			return { type: "custom", name: toolChoice.custom.name }
		case "allowed_tools":
			return {
				type: "allowed_tools",
				mode: toolChoice.allowed_tools.mode,
				tools: toolChoice.allowed_tools.tools.map((entry) => {
					if (entry.type !== "function") return entry
					const ref = entry.function
					const name = ref && typeof ref === "object" && "name" in ref ? ref.name : undefined
					if (typeof name !== "string" || !name)
						throw new Error("Responses allowed_tools entry requires a function name")
					return { type: "function", name }
				}),
			}
	}
}
