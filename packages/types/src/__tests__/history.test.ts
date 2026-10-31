import { historyItemSchema, pendingTaskActionSchema } from "../history.js"

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

describe("historyItemSchema", () => {
	const baseItem = {
		id: "task-1",
		number: 1,
		ts: 1,
		task: "Original prompt",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}

	it("keeps a user-assigned title", () => {
		expect(historyItemSchema.parse({ ...baseItem, title: "Renamed" }).title).toBe("Renamed")
	})

	it("leaves title unset when absent", () => {
		expect(historyItemSchema.parse(baseItem)).not.toHaveProperty("title")
	})
})

describe("usageByModel on history items", () => {
	const base = { id: "task-1", number: 1, ts: 1, task: "t", tokensIn: 1, tokensOut: 1, totalCost: 0 }

	it("preserves every field of a per-model entry", () => {
		const entry = {
			apiProvider: "provider-a",
			modelId: "model-a",
			requests: 3,
			tokensIn: 100,
			tokensOut: 50,
			cacheReads: 40,
			cacheWrites: 10,
			cost: 0.25,
		}
		expect(historyItemSchema.parse({ ...base, usageByModel: [entry, { ...entry, modelId: "model-b" }] })).toEqual({
			...base,
			usageByModel: [entry, { ...entry, modelId: "model-b" }],
		})
	})

	it("accepts an entry with no provider, model or cache counts, and an item with no breakdown", () => {
		const bare = { requests: 1, tokensIn: 2, tokensOut: 3, cost: 0 }
		expect(historyItemSchema.parse({ ...base, usageByModel: [bare] }).usageByModel).toEqual([bare])
		expect(historyItemSchema.parse(base).usageByModel).toBeUndefined()
	})

	it.each([
		["a missing request count", { tokensIn: 1, tokensOut: 1, cost: 0 }],
		["a non-numeric cost", { requests: 1, tokensIn: 1, tokensOut: 1, cost: "free" }],
		["a non-numeric token count", { requests: 1, tokensIn: "1", tokensOut: 1, cost: 0 }],
	])("rejects %s", (_name, entry) => {
		expect(historyItemSchema.safeParse({ ...base, usageByModel: [entry] }).success).toBe(false)
	})
})
