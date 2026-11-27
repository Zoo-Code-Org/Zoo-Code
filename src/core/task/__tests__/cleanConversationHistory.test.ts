// npx vitest core/task/__tests__/cleanConversationHistory.test.ts
//
// Direct unit spec for the shared history cleaner. The cleaner projects stored
// API history into the exact item sequence a request sends: standalone
// reasoning rides as a reasoning item when encrypted and is skipped when plain
// text, an assistant message with an embedded reasoning block is split so the
// reasoning rides as its own item, reasoning_details are carried on the
// assistant message, string content is normalized to blocks and single text
// blocks collapse back to strings, and role-less messages are dropped. The
// task loop and the condense request both send through this projection
// (issue 2453).

import Anthropic from "@anthropic-ai/sdk"
import type { ModelInfo } from "@roo-code/types"
import { describe, it, expect } from "vitest"

import type { ApiMessage } from "../../task-persistence"
import { buildCleanConversationHistory } from "../cleanConversationHistory"

function modelInfo(preserveReasoning?: boolean): ModelInfo {
	return {
		contextWindow: 1_000,
		supportsPromptCache: false,
		...(preserveReasoning === undefined ? {} : { preserveReasoning }),
	}
}

function textBlock(text: string): Anthropic.Messages.TextBlockParam {
	return { type: "text", text }
}

describe("buildCleanConversationHistory", () => {
	describe("standalone reasoning messages", () => {
		it.each([
			{ name: "with an id", id: "rs_1" },
			{ name: "without an id", id: undefined },
		])("sends an encrypted standalone reasoning message $name", ({ id }) => {
			const stored = {
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Planning" }],
				encrypted_content: "enc_1",
				...(id ? { id } : {}),
			} as unknown as ApiMessage

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([
				{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "Planning" }],
					encrypted_content: "enc_1",
					...(id ? { id } : {}),
				},
			])
		})

		it("skips a plain-text standalone reasoning message", () => {
			const stored = {
				type: "reasoning",
				text: "plain thinking",
				summary: [],
			} as unknown as ApiMessage

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([])
		})
	})

	describe("assistant messages with reasoning_details", () => {
		const reasoningDetails = [{ type: "reasoning_detail", text: "detail" }]

		it.each([
			{
				name: "normalizes string content and collapses a single text block back to a string",
				content: "answer" as string | Anthropic.Messages.ContentBlockParam[] | undefined,
				expected: "answer" as string | Anthropic.Messages.ContentBlockParam[],
			},
			{
				name: "keeps multi-block content as blocks",
				content: [textBlock("first"), textBlock("second")],
				expected: [textBlock("first"), textBlock("second")],
			},
			{
				name: "sends empty content when the message has no content",
				content: undefined,
				expected: "",
			},
		])("$name", ({ content, expected }) => {
			const stored = {
				role: "assistant",
				content,
				reasoning_details: reasoningDetails,
			} as unknown as ApiMessage

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([
				{ role: "assistant", content: expected, reasoning_details: reasoningDetails },
			])
		})
	})

	describe("assistant messages with an embedded encrypted reasoning block", () => {
		const encryptedBlock = {
			type: "reasoning",
			summary: [{ type: "summary_text", text: "Plan" }],
			encrypted_content: "enc_1",
			id: "rs_1",
		} as unknown as Anthropic.Messages.ContentBlockParam

		it("splits the block off and collapses the remaining single text block to a string", () => {
			const stored: ApiMessage = {
				role: "assistant",
				content: [encryptedBlock, textBlock("answer")],
			}

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([
				{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "Plan" }],
					encrypted_content: "enc_1",
					id: "rs_1",
				},
				{ role: "assistant", content: "answer" },
			])
		})

		it("keeps the remaining assistant content as blocks when several blocks follow", () => {
			const stored: ApiMessage = {
				role: "assistant",
				content: [encryptedBlock, textBlock("first"), textBlock("second")],
			}

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([
				{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "Plan" }],
					encrypted_content: "enc_1",
					id: "rs_1",
				},
				{ role: "assistant", content: [textBlock("first"), textBlock("second")] },
			])
		})
	})

	describe("assistant messages with an embedded plain-text reasoning block", () => {
		const plainBlock = {
			type: "reasoning",
			text: "hidden chain of thought",
			summary: [],
		} as unknown as Anthropic.Messages.ContentBlockParam

		it("keeps the reasoning block when the snapshot sets preserveReasoning", () => {
			const stored: ApiMessage = {
				role: "assistant",
				content: [plainBlock, textBlock("answer")],
			}

			const history = buildCleanConversationHistory([stored], modelInfo(true))

			expect(history).toStrictEqual([{ role: "assistant", content: [plainBlock, textBlock("answer")] }])
		})

		it("strips the reasoning block and collapses the rest to a string otherwise", () => {
			const stored: ApiMessage = {
				role: "assistant",
				content: [plainBlock, textBlock("answer")],
			}

			const history = buildCleanConversationHistory([stored], modelInfo(false))

			expect(history).toStrictEqual([{ role: "assistant", content: "answer" }])
		})
	})

	describe("regular messages", () => {
		it("passes a string-content message through unchanged", () => {
			const stored: ApiMessage = { role: "user", content: "hello" }

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([{ role: "user", content: "hello" }])
		})

		it("passes block-content messages through unchanged", () => {
			const stored: ApiMessage = { role: "user", content: [textBlock("hello")] }

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([{ role: "user", content: [textBlock("hello")] }])
		})

		it("skips a message without a role", () => {
			const stored = { content: [textBlock("orphan")] } as unknown as ApiMessage

			const history = buildCleanConversationHistory([stored], modelInfo())

			expect(history).toStrictEqual([])
		})
	})
})
