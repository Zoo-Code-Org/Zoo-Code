import { historyItemSchema, pendingHandoffSchema, pendingTaskActionSchema } from "../history.js"

describe("pendingHandoffSchema", () => {
	it("rejects an empty preserve profile name but keeps exact whitespace identities", () => {
		expect(
			pendingHandoffSchema.safeParse({ kind: "preserve", version: 1, mode: "code", profileName: "" }).success,
		).toBe(false)
		expect(
			pendingHandoffSchema.safeParse({ kind: "preserve", version: 1, mode: "code", profileName: " " }).success,
		).toBe(true)
		expect(pendingHandoffSchema.safeParse({ kind: "preserve", version: 1, mode: "code" }).success).toBe(true)
	})
})

describe("pendingTaskActionSchema", () => {
	it("accepts create and finish subtask actions", () => {
		expect(
			pendingTaskActionSchema.parse({
				kind: "create_subtask",
				actionId: "create-1",
				approvalText: "{}",
				mode: "ask",
				message: "Child",
				todos: [],
			}),
		).toMatchObject({ kind: "create_subtask", actionId: "create-1" })
		expect(
			pendingTaskActionSchema.parse({
				kind: "finish_subtask",
				actionId: "finish-1",
				approvalText: "{}",
				parentTaskId: "parent-1",
				result: "Done",
			}),
		).toMatchObject({ kind: "finish_subtask", actionId: "finish-1" })
	})

	it("round-trips pending actions on history items", () => {
		const parsed = historyItemSchema.parse({
			id: "task-1",
			number: 1,
			ts: 1,
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			pendingAction: {
				kind: "finish_subtask",
				actionId: "finish-1",
				approvalText: "{}",
				parentTaskId: "parent-1",
				result: "Done",
			},
		})

		expect(parsed.pendingAction?.actionId).toBe("finish-1")
	})
})
