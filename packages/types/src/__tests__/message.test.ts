// pnpm --filter @roo-code/types test src/__tests__/message.test.ts

import {
	changeCardDetailSchema,
	changeCardFileSchema,
	changeCardSchema,
	clineAsks,
	clineMessageSchema,
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

describe("clineMessageSchema autoApprovalDecision", () => {
	it.each(["approve", "deny"] as const)("accepts %s", (autoApprovalDecision) => {
		expect(clineMessageSchema.safeParse({ ts: 1, type: "ask", ask: "command", autoApprovalDecision }).success).toBe(
			true,
		)
	})

	it("rejects invalid decisions", () => {
		expect(
			clineMessageSchema.safeParse({ ts: 1, type: "ask", ask: "command", autoApprovalDecision: "ask" }).success,
		).toBe(false)
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

describe("change-card schemas", () => {
	it("accepts a valid full-detail change card", () => {
		const card = {
			stepId: "step-1",
			checkpointIds: ["abc123"],
			files: [{ path: "src/a.ts", additions: 3, deletions: 1, diff: "@@ -1 +1 @@" }],
			totalFiles: 1,
			detail: "full",
		}
		expect(changeCardSchema.parse(card)).toEqual(card)
	})

	it("accepts a summary card without stepId and without per-file diffs", () => {
		const card = {
			checkpointIds: [],
			files: [{ path: "src/b.ts", additions: 0, deletions: 2 }],
			totalFiles: 1,
			detail: "summary",
		}
		expect(changeCardSchema.parse(card)).toEqual(card)
	})

	it("rejects invalid detail values", () => {
		expect(() => changeCardDetailSchema.parse("detailed")).toThrow()
		expect(() => changeCardDetailSchema.parse(undefined)).toThrow()
		expect(() => changeCardSchema.parse({ checkpointIds: [], files: [], totalFiles: 0, detail: "diff" })).toThrow()
	})

	it("rejects incomplete file entries", () => {
		// Missing additions/deletions.
		expect(() => changeCardFileSchema.parse({ path: "src/a.ts" })).toThrow()
		// Missing path.
		expect(() => changeCardFileSchema.parse({ additions: 1, deletions: 0 })).toThrow()
		// Wrong stat type.
		expect(() => changeCardFileSchema.parse({ path: "src/a.ts", additions: "1", deletions: 0 })).toThrow()
	})

	it("rejects incomplete payloads", () => {
		// Missing checkpointIds.
		expect(() => changeCardSchema.parse({ files: [], totalFiles: 1, detail: "full" })).toThrow()
		// Missing files.
		expect(() => changeCardSchema.parse({ checkpointIds: [], totalFiles: 1, detail: "full" })).toThrow()
		// Missing totalFiles.
		expect(() => changeCardSchema.parse({ checkpointIds: [], files: [], detail: "full" })).toThrow()
		// Missing detail.
		expect(() => changeCardSchema.parse({ checkpointIds: [], files: [], totalFiles: 1 })).toThrow()
	})
})
