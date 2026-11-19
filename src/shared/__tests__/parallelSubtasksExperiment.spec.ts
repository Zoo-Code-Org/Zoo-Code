// npx vitest run src/shared/__tests__/parallelSubtasksExperiment.spec.ts

import { experimentIds, experimentIdsSchema, experimentsSchema } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentConfigsMap, experimentDefault, experiments } from "../experiments"

describe("PARALLEL_SUBTASKS experiment", () => {
	it("registers the id and the config entry", () => {
		expect(EXPERIMENT_IDS.PARALLEL_SUBTASKS).toBe("parallelSubtasks")
		expect(experimentConfigsMap.PARALLEL_SUBTASKS).toMatchObject({ enabled: false, showInSettings: true })
	})

	it("is off by default and follows the explicit value when present", () => {
		expect(experimentDefault.parallelSubtasks).toBe(false)
		expect(experiments.isEnabled({}, "parallelSubtasks")).toBe(false)
		expect(experiments.isEnabled({ parallelSubtasks: false }, "parallelSubtasks")).toBe(false)
		expect(experiments.isEnabled({ parallelSubtasks: true }, "parallelSubtasks")).toBe(true)
	})

	it("stays independent of parallelToolExecution", () => {
		expect(experiments.isEnabled({ parallelToolExecution: true }, "parallelSubtasks")).toBe(false)
		expect(experiments.isEnabled({ parallelSubtasks: true }, "parallelToolExecution")).toBe(false)
	})

	it("leaves every other experiment default unchanged", () => {
		expect(experimentDefault).toEqual({
			preventFocusDisruption: false,
			imageGeneration: false,
			runSlashCommand: false,
			customTools: false,
			parallelToolExecution: false,
			parallelSubtasks: false,
			dynamicThinkingEffort: false,
		})
	})
})

describe("experimentsSchema parallelSubtasks round trip", () => {
	it("admits the id through the enum", () => {
		expect(experimentIds).toContain("parallelSubtasks")
		expect(experimentIdsSchema.parse("parallelSubtasks")).toBe("parallelSubtasks")
	})

	it("parses the enabled, disabled and absent states", () => {
		expect(experimentsSchema.parse({ parallelSubtasks: true })).toEqual({ parallelSubtasks: true })
		expect(experimentsSchema.parse({ parallelSubtasks: false })).toEqual({ parallelSubtasks: false })
		expect(experimentsSchema.parse({})).toEqual({})
	})

	it("strips an unknown key rather than rejecting it", () => {
		expect(experimentsSchema.parse({ parallelSubtasks: true, notAnExperiment: true })).toEqual({
			parallelSubtasks: true,
		})
	})

	it("rejects a non-boolean value", () => {
		expect(experimentsSchema.safeParse({ parallelSubtasks: "yes" }).success).toBe(false)
	})

	it("accepts every registered experiment id", () => {
		for (const id of experimentIds) {
			expect(experimentsSchema.safeParse({ [id]: true }).success).toBe(true)
		}
	})
})
