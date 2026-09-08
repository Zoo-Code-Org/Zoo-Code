// npx vitest run core/task/__tests__/Task.buildCleanConversationHistory.reasoning.spec.ts

import { describe, expect, it, vi } from "vitest"

import type { ModelInfo } from "@roo-code/types"

import type { ApiMessage } from "../../task-persistence"
import { Task } from "../Task"

/**
 * Focused specs for `Task.buildCleanConversationHistory` and its two narrowing
 * helpers (`asEncryptedReasoningContentBlockParam` / `asPlainTextReasoningContentBlockParam`).
 * The REQ-005 mutation-gate run flagged this region (Task.ts L226-L248 helpers and the
 * L5045-L5102 branch selection) as NoCoverage: no spec had ever driven an assistant
 * message whose first content block is a reasoning variant. Every expectation below is
 * an exact deep-equality on the rebuilt request so any flipped guard, dropped `??`
 * fallback, id-spread change, or branch swap inverts at least one assertion.
 */

/**
 * The reasoning content-block variant is deliberately outside the Anthropic
 * `ContentBlockParam` union (that is exactly why `Task.ts` narrows it with the two
 * type-guard helpers), and production writes it through the same out-of-band storage
 * path (`prepareApiConversationMessage`). The `unknown`-mediated assertion here is the
 * only way to carry that intentional out-of-band shape through a test fixture without
 * `as any`.
 */
const asApiMessage = (message: Record<string, unknown>): ApiMessage => message as unknown as ApiMessage

/**
 * `Task.buildCleanConversationHistory` only reaches `this.api.getModel().info.preserveReasoning`
 * in the plain-text branch. A minimal typed double is attached through `unknown` because
 * `ApiHandler` is a large class surface; this mirrors the bracket-notation seam used by
 * `ask-allowlist-cwd.spec.ts` without changing production visibility.
 */
function buildTask(modelOverrides: Partial<ModelInfo> = {}): Task {
	const task = Object.create(Task.prototype) as Task
	const info: ModelInfo = { contextWindow: 16000, supportsPromptCache: true, ...modelOverrides }
	task.api = { getModel: () => ({ id: "test-model", info }) } as unknown as Task["api"]
	return task
}

function buildHistory(task: Task, messages: ApiMessage[]) {
	return task["buildCleanConversationHistory"](messages)
}

describe("Task.buildCleanConversationHistory: encrypted reasoning first block", () => {
	it("splits an assistant message into a reasoning item (with summary/id) plus the stripped message", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({ role: "user", content: [{ type: "text", text: "question" }] }),
			asApiMessage({
				role: "assistant",
				content: [
					{
						type: "reasoning",
						encrypted_content: "enc-1",
						id: "rs_1",
						summary: [{ type: "summary_text", text: "gist" }],
					},
					{ type: "text", text: "answer" },
				],
			}),
		]

		// Exact match: the reasoning item must carry the real summary array (a dropped
		// `?? []` fallback yields `summary: undefined`; an id-spread mutation drops or
		// invents `id`), and the assistant entry must contain only the remaining block's
		// text (rest.length === 1 collapse; any branch mutant leaks the raw array here).
		expect(buildHistory(task, messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "question" }] },
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "gist" }],
				encrypted_content: "enc-1",
				id: "rs_1",
			},
			{ role: "assistant", content: "answer" },
		])
	})

	it("defaults the summary to an empty array and omits the id when the block has neither", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({
				role: "assistant",
				content: [
					{ type: "reasoning", encrypted_content: "enc-2" },
					{ type: "text", text: "answer" },
					{ type: "text", text: "tail" },
				],
			}),
		]

		// `summary` must be `[]` (mutants: `??`→`&&` produces `undefined`;
		// array-declaration produces a placeholder), and no `id` key at all
		// (ObjectLiteral mutant on the conditional spread would add one).
		// `toEqual` ignores `undefined`-valued keys, so the key-absence claim is
		// pinned separately via `not.toHaveProperty` — a mutant that flattens the
		// conditional spread to an unconditional `id: encryptedReasoning.id`
		// would pass the deep-equal but fails the property check.
		const history = buildHistory(task, messages)
		expect(history[0]).not.toHaveProperty("id")
		expect(history).toEqual([
			{ type: "reasoning", summary: [], encrypted_content: "enc-2" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "answer" },
					{ type: "text", text: "tail" },
				],
			},
		])
	})

	it("collapses to empty-string content when the reasoning block is the only content", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({ role: "assistant", content: [{ type: "reasoning", encrypted_content: "enc-3" }] }),
		]

		// Same id-absence pin as above: the conditionally-spread `id` must not
		// appear as an `undefined`-valued key that `toEqual` would ignore.
		const history = buildHistory(task, messages)
		expect(history[0]).not.toHaveProperty("id")
		expect(history).toEqual([
			{ type: "reasoning", summary: [], encrypted_content: "enc-3" },
			{ role: "assistant", content: "" },
		])
	})
})

describe("Task.buildCleanConversationHistory: plain-text reasoning first block", () => {
	const plainFirstAssistant = (): ApiMessage[] => [
		asApiMessage({
			role: "assistant",
			content: [
				{ type: "reasoning", text: "visible reasoning" },
				{ type: "text", text: "answer" },
			],
		}),
	]

	it("strips the reasoning block when the model does not preserve reasoning", () => {
		const task = buildTask({ preserveReasoning: false })

		expect(buildHistory(task, plainFirstAssistant())).toEqual([{ role: "assistant", content: "answer" }])
	})

	it("keeps the full content array when the model preserves reasoning", () => {
		const task = buildTask({ preserveReasoning: true })

		// The exact-match array must still contain the reasoning block; a branch mutant
		// (e.g. `preserveReasoning === true` flipped) strips it and breaks this.
		expect(buildHistory(task, plainFirstAssistant())).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "visible reasoning" },
					{ type: "text", text: "answer" },
				],
			},
		])
	})

	it("treats a missing preserveReasoning flag as false (reasoning stripped)", () => {
		const task = buildTask()

		expect(buildHistory(task, plainFirstAssistant())).toEqual([{ role: "assistant", content: "answer" }])
	})

	it("collapses to empty-string content when the reasoning block is the only content", () => {
		const task = buildTask()
		const messages = [asApiMessage({ role: "assistant", content: [{ type: "reasoning", text: "solo" }] })]

		expect(buildHistory(task, messages)).toEqual([{ role: "assistant", content: "" }])
	})
})

describe("Task.buildCleanConversationHistory: reasoning-block guard rejection", () => {
	it("passes a non-reasoning first block through untouched", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({ role: "assistant", content: [{ type: "text", text: "plain" }] }),
			asApiMessage({ role: "user", content: "next question" }),
		]

		// Default path forwards the stored content verbatim (array stays an array,
		// string stays a string): both guards must have returned undefined.
		expect(buildHistory(task, messages)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "plain" }] },
			{ role: "user", content: "next question" },
		])
	})

	it("rejects a non-reasoning first block that carries a stray encrypted_content payload", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer", encrypted_content: "stray" }],
			}),
		]

		// This pins the type leg of `asEncryptedReasoningContentBlockParam`: if the
		// guard is skipped (ConditionalExpression→false mutant), the payload check
		// alone would classify the block as encrypted reasoning and split the message
		// into a reasoning item + stripped content. Real code passes it through.
		expect(buildHistory(task, messages)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "answer", encrypted_content: "stray" }] },
		])
	})

	it("passes a reasoning-typed block without a string payload through untouched", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({
				role: "assistant",
				content: [
					{ type: "reasoning", summary: [{ type: "summary_text", text: "gist" }] },
					{ type: "text", text: "answer" },
				],
			}),
		]

		// Neither `encrypted_content` nor `text` is a string, so both narrowing
		// helpers must return undefined and the message keeps its raw content.
		expect(buildHistory(task, messages)).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", summary: [{ type: "summary_text", text: "gist" }] },
					{ type: "text", text: "answer" },
				],
			},
		])
	})

	it("passes an assistant message with empty content through untouched", () => {
		const task = buildTask()
		const messages = [asApiMessage({ role: "assistant", content: [] })]

		// `first` is undefined here, exercising the `!block` leg of both guards.
		expect(buildHistory(task, messages)).toEqual([{ role: "assistant", content: [] }])
	})
})

describe("Task.buildCleanConversationHistory: standalone reasoning messages", () => {
	it("forwards a standalone encrypted reasoning item and drops plain-text-only ones", () => {
		const task = buildTask()
		const messages = [
			asApiMessage({
				type: "reasoning",
				encrypted_content: "enc-standalone",
				id: "rs_s",
				summary: [{ type: "summary_text", text: "gist" }],
			}),
			asApiMessage({ role: "user", content: [{ type: "text", text: "after" }] }),
			// No encrypted_content: standalone reasoning is skipped entirely.
			asApiMessage({ type: "reasoning", text: "plain standalone" }),
		]

		expect(buildHistory(task, messages)).toEqual([
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "gist" }],
				encrypted_content: "enc-standalone",
				id: "rs_s",
			},
			{ role: "user", content: [{ type: "text", text: "after" }] },
		])
	})

	it("omits the id key on a standalone reasoning item without one", () => {
		const task = buildTask()
		const history = buildHistory(task, [asApiMessage({ type: "reasoning", encrypted_content: "enc" })])

		// Key absence must be pinned explicitly: `toEqual` treats `{ id: undefined }`
		// as equal to `{}`, so the standalone item's `...(msg.id ? { id: msg.id } : {})`
		// spread needs the property check to kill an unconditional-spread mutant.
		expect(history[0]).not.toHaveProperty("id")
		expect(history).toEqual([{ type: "reasoning", encrypted_content: "enc" }])
	})
})

describe("Task.buildCleanConversationHistory: reasoning_details (OpenRouter style)", () => {
	it("rebuilds the assistant message with reasoning_details and collapsed text content", () => {
		const task = buildTask()
		const reasoningDetails = [{ id: "resp-1", type: "reasoning", text: "od reasoning" }]
		const messages = [
			asApiMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				reasoning_details: reasoningDetails,
			}),
		]

		// contentArray is a single text block → collapsed to the string; the embedded
		// reasoning guards must never see this message (the `continue` skips them).
		expect(buildHistory(task, messages)).toEqual([
			{ role: "assistant", content: "answer", reasoning_details: reasoningDetails },
		])
	})
})
