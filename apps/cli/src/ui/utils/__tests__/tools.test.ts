import { extractToolData } from "../tools.js"

describe("extractToolData for parallel subtasks", () => {
	it("extracts the approval rows sent under tasks", () => {
		const toolData = extractToolData({
			tool: "parallelSubtasks",
			tasks: [
				{ label: "api", mode: "architect", message: "Map the REST surface" },
				{ label: "tests", mode: "ask", message: "Find untested modules" },
			],
		})

		expect(toolData.tool).toBe("parallelSubtasks")
		expect(toolData.subtasks).toHaveLength(2)
		expect(toolData.subtasks?.[0]).toMatchObject({
			label: "api",
			mode: "architect",
			message: "Map the REST surface",
		})
		expect(toolData.subtasks?.[1]).toMatchObject({
			label: "tests",
			mode: "ask",
			message: "Find untested modules",
		})
	})

	it("extracts the terminal progress rows sent under subtasks", () => {
		const toolData = extractToolData({
			tool: "parallelSubtasks",
			subtasks: [
				{
					taskId: "child-1",
					label: "api",
					mode: "architect",
					status: "completed",
					reportPath: "/workspace/.zoocode/subtask-reports/parent/api-child-1.md",
					summary: "3 endpoints mapped",
				},
				{
					taskId: "child-2",
					label: "tests",
					mode: "ask",
					status: "failed",
					error: "denied write_to_file",
				},
			],
		})

		expect(toolData.subtasks).toHaveLength(2)
		expect(toolData.subtasks?.[0]).toMatchObject({
			taskId: "child-1",
			label: "api",
			mode: "architect",
			status: "completed",
			reportPath: "/workspace/.zoocode/subtask-reports/parent/api-child-1.md",
			summary: "3 endpoints mapped",
		})
		expect(toolData.subtasks?.[1]).toMatchObject({
			taskId: "child-2",
			status: "failed",
			error: "denied write_to_file",
		})
	})

	it("prefers subtasks over tasks when both are present", () => {
		const toolData = extractToolData({
			tool: "parallelSubtasks",
			tasks: [{ label: "stale", mode: "code", message: "approval row" }],
			subtasks: [{ label: "live", mode: "code", status: "running" }],
		})

		expect(toolData.subtasks).toHaveLength(1)
		expect(toolData.subtasks?.[0]).toMatchObject({ label: "live", status: "running" })
	})

	it.each([
		{ name: "a missing tasks array", payload: { tool: "parallelSubtasks" }, expected: undefined },
		{ name: "a non-array tasks value", payload: { tool: "parallelSubtasks", tasks: "nope" }, expected: undefined },
		{ name: "an empty tasks array", payload: { tool: "parallelSubtasks", tasks: [] }, expected: [] },
	])("tolerates $name", ({ payload, expected }) => {
		expect(extractToolData(payload).subtasks).toEqual(expected)
	})
})
