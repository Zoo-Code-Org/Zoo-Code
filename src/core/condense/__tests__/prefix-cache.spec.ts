// npx vitest src/core/condense/__tests__/prefix-cache.spec.ts
//
// Issue 2453: condensation must preserve the provider's prefix KV cache.
// The provider reuses cached work only when a request starts exactly like the
// previous request. The previous request is the task request: the task system
// prompt plus the task-shaped history (merge consecutive user messages, clean
// images when unsupported, native content blocks). The condense request must
// therefore send that exact sequence as a prefix and append only suffixes:
// synthetic tool results for orphan tool calls, then the condense instruction
// as the last message. The spec lives in docs/architecture/tla/
// CondenseRequestPrefix.tla.

import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import { BaseProvider } from "../../../api/providers/base-provider"
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
	messages: Array<{ role: string; content: string | Anthropic.Messages.ContentBlockParam[] }>
	metadata?: ApiHandlerCreateMessageMetadata
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
// the same merge, the same image cleaning, the same role/content projection.
function expectedTaskShaped(messages: ApiMessage[], handler: CapturingApiHandler) {
	const effective = getMessagesSinceLastSummary(getEffectiveApiHistory(messages))
	const merged = mergeConsecutiveApiMessages(effective, { roles: ["user"] })
	const cleaned = maybeRemoveImageBlocks(merged, handler)
	return cleaned.map(({ role, content }) => ({ role, content }))
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

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		const expectedPrefix = expectedTaskShaped(messages, handler)
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

		const sent = handler.requests[0].messages
		const assistant = sent.find((message) => message.role === "assistant")
		expect(assistant?.content).toStrictEqual([
			textBlock("Reading the tokenizer"),
			{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/tokenizer.ts" } },
		])
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

		const sent = handler.requests[0].messages
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

		await summarizeConversation({
			messages,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		const expectedPrefix = expectedTaskShaped(messages, handler)
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

		await summarizeConversation({
			messages: history,
			apiHandler: handler,
			systemPrompt: taskSystemPrompt,
			taskId,
		})

		const sent = handler.requests[0].messages
		const expectedPrefix = expectedTaskShaped(history, handler)
		expect(sent.length).toBeGreaterThanOrEqual(expectedPrefix.length + 1)
		expect(sent.slice(0, expectedPrefix.length)).toStrictEqual(expectedPrefix)
	})
})
