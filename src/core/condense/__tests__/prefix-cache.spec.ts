// npx vitest src/core/condense/__tests__/prefix-cache.spec.ts
//
// Issue 2453: condensation must preserve the provider's prefix KV cache.
// The provider reuses cached work only when a request starts exactly like the
// previous request. The previous request is the task request: the task system
// prompt plus the task-shaped history (merge consecutive user messages, clean
// images when unsupported, run the shared history cleaner so embedded
// reasoning rides as separate reasoning items, send native content blocks).
// The condense request must therefore send that exact sequence as a prefix and
// append only suffixes: synthetic tool results for orphan tool calls, then the
// condense instruction as the last message. The spec lives in
// docs/architecture/tla/CondenseRequestPrefix.tla.

import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import { BaseProvider } from "../../../api/providers/base-provider"
import { supportPrompt } from "../../../shared/support-prompt"
import { buildCleanConversationHistory, type CleanConversationHistoryItem } from "../../task/cleanConversationHistory"
import { mergeConsecutiveApiMessages } from "../../task/mergeConsecutiveApiMessages"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	buildCondenseInstruction,
	getEffectiveApiHistory,
	getMessagesSinceLastSummary,
	summarizeConversation,
} from "../index"

const taskId = "prefix-cache-task"
const taskSystemPrompt = "You are a coding agent operating in a workspace."

type CapturedRequest = {
	systemPrompt: string
	messages: CleanConversationHistoryItem[]
	metadata?: ApiHandlerCreateMessageMetadata
}

function asApiMessage(item: CleanConversationHistoryItem): Anthropic.Messages.MessageParam {
	return item as Anthropic.Messages.MessageParam
}

class CapturingApiHandler extends BaseProvider {
	public requests: CapturedRequest[] = []

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.requests.push({ systemPrompt, messages: structuredClone(messages), metadata })
		return summaryStream()
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "prefix-cache-model",
			info: {
				contextWindow: 100000,
				maxTokens: 50000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		let tokens = 0
		for (const block of content) {
			if (block.type === "text") {
				tokens += Math.ceil(block.text.length / 4)
			}
		}
		return tokens
	}
}

async function* summaryStream(): ApiStream {
	yield { type: "text", text: "Mock summary of the conversation" }
	yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.01 }
}

function textBlock(text: string): Anthropic.Messages.TextBlockParam {
	return { type: "text", text }
}

function buildHistory(): ApiMessage[] {
	return [
		{
			role: "user",
			content: [textBlock("Task: fix the parser"), textBlock("Focus on the tokenizer first")],
		},
		{
			role: "assistant",
			content: [
				textBlock("Reading the tokenizer"),
				{
					type: "tool_use",
					id: "toolu_1",
					name: "read_file",
					input: { path: "src/tokenizer.ts" },
				},
			],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "const x = 1" }],
		},
		{
			role: "user",
			content: [textBlock("Remember the release checklist")],
		},
	]
}

// The request shape the task loop sends on a normal turn: the same selection,
// the same merge, the same image cleaning, the same history cleaner, the same
// item projection.
function expectedTaskShaped(messages: ApiMessage[], handler: CapturingApiHandler): CleanConversationHistoryItem[] {
	const effective = getMessagesSinceLastSummary(getEffectiveApiHistory(messages))
	const merged = mergeConsecutiveApiMessages(effective, { roles: ["user"] })
	const cleaned = maybeRemoveImageBlocks(merged, handler)
	return buildCleanConversationHistory(cleaned, handler.getModel().info)
}

describe("Condense request prefix cache", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	describe("buildCondenseInstruction", () => {
		it("wraps the default template with a no-tools guard", () => {
			const instruction = buildCondenseInstruction(undefined)
			expect(instruction).toContain("SYSTEM OPERATION")
			expect(instruction).toContain("DO NOT call any tools")
			// The full default template must ride along: a guard-only return
			// would drop the summary instructions.
			expect(instruction).toContain(supportPrompt.default.CONDENSE)
		})

		it("wraps a custom condensing prompt with the same guard", () => {
			const instruction = buildCondenseInstruction("Custom condensing instructions.")
			expect(instruction).toContain("Custom condensing instructions.")
			expect(instruction).toContain("DO NOT call any tools")
		})
	})

	it("sends the task system prompt, not a condense-only system prompt", async () => {
		const handler = new CapturingApiHandler()

		await summarizeConversation({
			messages: buildHistory(),
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		expect(handler.requests).toHaveLength(1)
		expect(handler.requests[0].systemPrompt).toBe(taskSystemPrompt)
	})

	it("keeps the task-shaped history as a byte-identical prefix and appends one instruction suffix", async () => {
		const handler = new CapturingApiHandler()
		const messages = buildHistory()
		// Freeze the expectation before the call: an in-place mutation of the
		// history must not leak into the observed prefix.
		const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		expect(sent).toHaveLength(expectedPrefix.length + 1)
		expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
	})

	it("sends native tool blocks instead of text conversions", async () => {
		const handler = new CapturingApiHandler()
		const messages = buildHistory()

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages.map(asApiMessage)
		const assistant = sent.find((message) => message.role === "assistant")
		expect(assistant?.content).toStrictEqual([
			textBlock("Reading the tokenizer"),
			{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/tokenizer.ts" } },
		])
	})

	it("extracts embedded encrypted reasoning into a separate reasoning item like the task request", async () => {
		const handler = new CapturingApiHandler()
		// OpenAI Native stores encrypted reasoning inside assistant content
		// blocks; the stored shape is not part of Anthropic's block union.
		const embeddedReasoning = {
			type: "reasoning",
			encrypted_content: "enc_reasoning_1",
			summary: [{ type: "summary_text", text: "Planning the refactor" }],
		} as unknown as Anthropic.Messages.ContentBlockParam
		const messages: ApiMessage[] = [
			{ role: "user", content: [textBlock("Task: refactor the parser")] },
			{
				role: "assistant",
				content: [embeddedReasoning, textBlock("Refactoring the parser now")],
			},
		]
		// Freeze the expectation before the call: an in-place mutation of the
		// history must not leak into the observed prefix.
		const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		expect(sent).toHaveLength(expectedPrefix.length + 1)
		expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
		// The embedded block must ride as its own reasoning item, then the
		// assistant message without it - exactly the items the task request sent.
		expect(sent[1]).toStrictEqual({
			type: "reasoning",
			summary: [{ type: "summary_text", text: "Planning the refactor" }],
			encrypted_content: "enc_reasoning_1",
		})
		expect(asApiMessage(sent[2])).toStrictEqual({ role: "assistant", content: "Refactoring the parser now" })
		const last = sent[sent.length - 1]
		expect(asApiMessage(last).content).toContain("DO NOT call any tools")
	})

	it("appends the condense instruction as the last message with a no-tools guard", async () => {
		const handler = new CapturingApiHandler()

		await summarizeConversation({
			messages: buildHistory(),
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
			customCondensingPrompt: "Custom condensing instructions.",
		})

		const sent = handler.requests[0].messages.map(asApiMessage)
		const last = sent[sent.length - 1]
		expect(last.role).toBe("user")
		expect(last.content).toContain("Custom condensing instructions.")
		expect(last.content).toContain("DO NOT call any tools")
	})

	it("injects synthetic tool results for orphan tool calls as a suffix, prefix intact", async () => {
		const handler = new CapturingApiHandler()
		const messages: ApiMessage[] = [
			{ role: "user", content: [textBlock("Task: ship the fix")] },
			{
				role: "assistant",
				content: [
					textBlock("Done"),
					{
						type: "tool_use",
						id: "toolu_orphan",
						name: "attempt_completion",
						input: { result: "Shipped" },
					},
				],
			},
		]

		// Freeze the expectation before the call: an in-place mutation of the
		// history must not leak into the observed prefix.
		const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages.map(asApiMessage)
		expect(sent).toHaveLength(expectedPrefix.length + 2)
		expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
		const synthetic = sent[expectedPrefix.length]
		expect(synthetic.role).toBe("user")
		expect(synthetic.content).toStrictEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_orphan",
				content: expect.any(String),
			},
		])
		const last = sent[sent.length - 1]
		expect(last.content).toContain("DO NOT call any tools")
	})

	it.each([
		{
			name: "with an image block that the model cannot take",
			messages: (): ApiMessage[] => [
				{
					role: "user",
					content: [
						textBlock("Task: review the mockup"),
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "aGk=" },
						} satisfies Anthropic.Messages.ImageBlockParam,
					],
				},
				{ role: "assistant", content: [textBlock("Reviewed")] },
			],
		},
		{
			name: "with consecutive user messages that merge in the task request",
			messages: (): ApiMessage[] => [
				{ role: "user", content: [textBlock("Task: fix the parser")] },
				{ role: "user", content: [textBlock("Also run the tests")] },
				{ role: "assistant", content: [textBlock("On it")] },
			],
		},
		{
			name: "with tool blocks the previous request sent natively",
			messages: (): ApiMessage[] => buildHistory(),
		},
	])("keeps the task-shaped prefix intact $name", async ({ messages }) => {
		const handler = new CapturingApiHandler()
		const history = messages()
		// Freeze the expectation before the call: an in-place mutation of the
		// history must not leak into the observed prefix.
		const expectedPrefix = structuredClone(expectedTaskShaped(history, handler))

		await summarizeConversation({
			messages: history,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		expect(sent.length).toBeGreaterThanOrEqual(expectedPrefix.length + 1)
		expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
	})

	describe("reasoning items and reasoning_details the task request sends", () => {
		function historyWithReasoningMessage(reasoningMessage: ApiMessage): ApiMessage[] {
			return [
				{ role: "user", content: [textBlock("Task: refactor the parser")] },
				reasoningMessage,
				{ role: "assistant", content: [textBlock("Refactoring the parser now")] },
			]
		}

		it("sends a standalone encrypted reasoning message as a reasoning item like the task request", async () => {
			const handler = new CapturingApiHandler()
			// A standalone reasoning message is stored with a type, not a role;
			// that stored shape is not part of Anthropic's message union.
			const reasoningMessage = {
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Planning the refactor" }],
				encrypted_content: "enc_standalone_1",
				id: "rs_standalone_1",
			} as unknown as ApiMessage
			const messages = historyWithReasoningMessage(reasoningMessage)
			// Freeze the expectation before the call: an in-place mutation of the
			// history must not leak into the observed prefix.
			const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

			await summarizeConversation({
				messages,
				apiHandler: handler,
				systemPrompt: taskSystemPrompt,
				taskId,
			})

			const sent = handler.requests[0].messages
			expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
			expect(sent[1]).toStrictEqual({
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Planning the refactor" }],
				encrypted_content: "enc_standalone_1",
				id: "rs_standalone_1",
			})
		})

		it("does not send a standalone plain-text reasoning message", async () => {
			const handler = new CapturingApiHandler()
			const reasoningMessage = {
				type: "reasoning",
				text: "plain thinking about the refactor",
				summary: [],
			} as unknown as ApiMessage
			const messages = historyWithReasoningMessage(reasoningMessage)
			// Freeze the expectation before the call: an in-place mutation of the
			// history must not leak into the observed prefix.
			const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

			await summarizeConversation({
				messages,
				apiHandler: handler,
				systemPrompt: taskSystemPrompt,
				taskId,
			})

			const sent = handler.requests[0].messages
			expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
			// The task request skips the plain-text reasoning message, so the
			// condense prefix must skip it in any shape too.
			expect(JSON.stringify(sent)).not.toContain("plain thinking about the refactor")
			expect(sent.some((item) => "type" in item && item.type === "reasoning")).toBe(false)
		})

		it("carries reasoning_details on the assistant message like the task request", async () => {
			const handler = new CapturingApiHandler()
			const reasoningDetails = [{ type: "reasoning_detail", text: "OpenRouter detail" }]
			const messages: ApiMessage[] = [
				{ role: "user", content: [textBlock("Task: refactor the parser")] },
				{
					role: "assistant",
					content: [textBlock("Refactoring the parser now")],
					reasoning_details: reasoningDetails,
				} as ApiMessage,
			]
			// Freeze the expectation before the call: an in-place mutation of the
			// history must not leak into the observed prefix.
			const expectedPrefix = structuredClone(expectedTaskShaped(messages, handler))

			await summarizeConversation({
				messages,
				apiHandler: handler,
				systemPrompt: taskSystemPrompt,
				taskId,
			})

			const sent = handler.requests[0].messages
			expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
			const assistant = sent.find((item) => "role" in item && item.role === "assistant")
			expect(assistant).toStrictEqual({
				role: "assistant",
				content: "Refactoring the parser now",
				reasoning_details: reasoningDetails,
			})
		})
	})
})
