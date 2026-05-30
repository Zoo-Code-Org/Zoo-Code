// npx vitest run packages/types/src/__tests__/learning-memory.test.ts

import {
	DEFAULT_LEARNING_CONFIG,
	EMPTY_LEARNING_STATE,
	learningConfigSchema,
	learningStateSchema,
	memoryContextSchema,
	type LearningState,
	type MemoryContext,
} from "../index.js"

describe("learning types", () => {
	it("exports the default learning config", () => {
		expect(DEFAULT_LEARNING_CONFIG).toMatchObject({
			enabled: false,
			reviewOnTurnCount: 10,
			reviewOnToolIterationCount: 50,
		})
	})

	it("parses the empty learning state", () => {
		const result = learningStateSchema.safeParse(EMPTY_LEARNING_STATE)

		expect(result.success).toBe(true)
		expect(result.data).toEqual(EMPTY_LEARNING_STATE)
	})

	it("applies learning config defaults", () => {
		const result = learningConfigSchema.parse({})

		expect(result).toEqual(DEFAULT_LEARNING_CONFIG)
	})

	it("preserves TypeScript inference for learning state", () => {
		const state: LearningState = EMPTY_LEARNING_STATE

		expect(state.version).toBe(1)
	})
})

describe("memory types", () => {
	it("parses a valid memory context", () => {
		const input: MemoryContext = {
			entries: [],
			revision: 0,
			generatedAt: Date.now(),
		}

		const result = memoryContextSchema.safeParse(input)

		expect(result.success).toBe(true)
		expect(result.data).toEqual(input)
	})

	it("rejects more than ten memory entries", () => {
		const result = memoryContextSchema.safeParse({
			entries: Array.from({ length: 11 }, (_, index) => ({
				id: `entry-${index}`,
				content: "memory",
				source: "learning",
				createdAt: index,
				updatedAt: index,
			})),
			revision: 0,
			generatedAt: Date.now(),
		})

		expect(result.success).toBe(false)
	})
})
