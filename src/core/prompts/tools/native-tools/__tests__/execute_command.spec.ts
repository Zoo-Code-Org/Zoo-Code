import executeCommand, { createExecuteCommandTool } from "../execute_command"

describe("execute_command schema", () => {
	it("preserves the strict default for existing integrations", () => {
		expect(createExecuteCommandTool()).toEqual(executeCommand)
		expect(executeCommand.function.strict).toBe(true)
		expect(executeCommand.function.parameters.required).toEqual(["command", "cwd", "timeout"])
	})

	it("requires only command for non-strict generation while retaining optional field types", () => {
		const original = structuredClone(executeCommand)
		const tool = createExecuteCommandTool({ strict: false })
		expect(tool.function.strict).toBe(false)
		expect(tool.function.parameters).toEqual({ ...original.function.parameters, required: ["command"] })
		expect(tool.function.parameters?.properties).toMatchObject({
			command: { type: "string" },
			cwd: { type: ["string", "null"] },
			timeout: { type: ["number", "null"] },
		})
		expect(executeCommand).toEqual(original)
	})

	it("does not share required arrays across generated schemas", () => {
		const first = createExecuteCommandTool({ strict: false })
		const second = createExecuteCommandTool({ strict: false })
		expect(first.function.parameters?.required).not.toBe(second.function.parameters?.required)
		expect(second.function.parameters?.required).toEqual(["command"])
		expect(executeCommand.function.parameters.required).toEqual(["command", "cwd", "timeout"])
	})
})
