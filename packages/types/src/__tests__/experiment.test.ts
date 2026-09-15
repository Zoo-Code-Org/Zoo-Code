import { experimentIds, experimentIdsSchema, experimentsSchema } from "../experiment.js"

describe("dynamicThinkingEffort experiment", () => {
	it("is part of the experiment id enum", () => {
		expect(experimentIds).toContain("dynamicThinkingEffort")
		expect(experimentIdsSchema.safeParse("dynamicThinkingEffort").success).toBe(true)
	})

	it("parses enabled and disabled states", () => {
		expect(experimentsSchema.parse({ dynamicThinkingEffort: true })).toEqual({ dynamicThinkingEffort: true })
		expect(experimentsSchema.parse({ dynamicThinkingEffort: false })).toEqual({ dynamicThinkingEffort: false })
		expect(experimentsSchema.parse({})).toEqual({})
	})

	it("rejects non-boolean values", () => {
		expect(experimentsSchema.safeParse({ dynamicThinkingEffort: "yes" }).success).toBe(false)
		expect(experimentIdsSchema.safeParse("dynamic-thinking-effort").success).toBe(false)
	})
})
