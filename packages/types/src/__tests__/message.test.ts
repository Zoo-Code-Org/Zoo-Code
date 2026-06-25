// pnpm --filter @roo-code/types test src/__tests__/message.test.ts

import {
	clineAsks,
	getCompletionCheckpoint,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isNonBlockingAsk,
	type ClineMessage,
} from "../message.js"

describe("ask messages", () => {
	test("all ask messages are classified", () => {
		for (const ask of clineAsks) {
			expect(
				isIdleAsk(ask) || isInteractiveAsk(ask) || isResumableAsk(ask) || isNonBlockingAsk(ask),
				`${ask} is not classified`,
			).toBe(true)
		}
	})
})

describe("getCompletionCheckpoint", () => {
	it("returns the first checkpoint after the latest user prompt before completion", () => {
		const messages: ClineMessage[] = [
			{ type: "say", say: "text", ts: 1, text: "Initial task" },
			{ type: "say", say: "checkpoint_saved", ts: 2, text: "initial-checkpoint" },
			{ type: "say", say: "completion_result", ts: 3, text: "First completion" },
			{ type: "say", say: "user_feedback", ts: 4, text: "Change it" },
			{ type: "say", say: "checkpoint_saved", ts: 5, text: "latest-prompt-checkpoint" },
			{ type: "say", say: "checkpoint_saved", ts: 6, text: "later-edit-checkpoint" },
			{ type: "ask", ask: "completion_result", ts: 7, text: "", partial: false },
		]

		expect(getCompletionCheckpoint(messages)).toEqual({
			ts: 5,
			commitHash: "latest-prompt-checkpoint",
		})
	})

	it("returns the first checkpoint after an initial task row before completion", () => {
		const messages: ClineMessage[] = [
			{ type: "say", say: "task", ts: 1, text: "Initial task" },
			{ type: "say", say: "checkpoint_saved", ts: 2, text: "checkpoint-after-initial-task" },
			{ type: "ask", ask: "completion_result", ts: 3, text: "Task complete", partial: false },
		]

		expect(getCompletionCheckpoint(messages)).toEqual({
			ts: 2,
			commitHash: "checkpoint-after-initial-task",
		})
	})

	it("returns undefined when completion has no checkpoint after the latest user prompt", () => {
		const messages: ClineMessage[] = [
			{ type: "say", say: "text", ts: 1, text: "Initial task" },
			{ type: "say", say: "checkpoint_saved", ts: 2, text: "initial-checkpoint" },
			{ type: "say", say: "user_feedback", ts: 3, text: "Change it" },
			{ type: "ask", ask: "completion_result", ts: 4, text: "", partial: false },
		]

		expect(getCompletionCheckpoint(messages)).toBeUndefined()
	})
})
