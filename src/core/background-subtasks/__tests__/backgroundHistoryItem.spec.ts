import { historyItemSchema } from "@roo-code/types"

const baseItem = {
	id: "task-1",
	number: 1,
	ts: 1,
	task: "Original prompt",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

describe("historyItemSchema backgroundParentTaskId (D10)", () => {
	it("parses an item with the background parent stamp", () => {
		const parsed = historyItemSchema.parse({ ...baseItem, backgroundParentTaskId: "parent-1" })

		expect(parsed.backgroundParentTaskId).toBe("parent-1")
	})

	it("round-trips the stamp through serialization and re-parse", () => {
		const parsed = historyItemSchema.parse({ ...baseItem, backgroundParentTaskId: "parent-1" })
		const serialized = JSON.parse(JSON.stringify(parsed)) as unknown

		expect(historyItemSchema.parse(serialized).backgroundParentTaskId).toBe("parent-1")
	})

	it("parses an item without the stamp and leaves it unset", () => {
		const parsed = historyItemSchema.parse(baseItem)

		expect(parsed).not.toHaveProperty("backgroundParentTaskId")
	})

	it("keeps the field optional alongside the delegation fields", () => {
		const withStamp = historyItemSchema.parse({
			...baseItem,
			status: "active",
			childIds: ["child-1"],
			awaitingChildId: "child-1",
			backgroundParentTaskId: "parent-1",
		})

		expect(withStamp.awaitingChildId).toBe("child-1")
		expect(withStamp.backgroundParentTaskId).toBe("parent-1")
	})
})
