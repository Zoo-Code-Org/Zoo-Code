import executeCommand, { createExecuteCommandTool } from "../execute_command"
import { getNativeTools, nativeTools } from ".."

describe("execute_command schema", () => {
	it("preserves the strict default for existing integrations", () => {
		expect(createExecuteCommandTool()).toEqual(executeCommand)
		expect(executeCommand.function.strict).toBe(true)
		expect(executeCommand.function.parameters.required).toEqual(["command", "cwd", "timeout"])
	})

	it.each([
		{ name: "getNativeTools()", tools: () => getNativeTools() },
		{ name: "nativeTools", tools: () => nativeTools },
	])("preserves the strict command schema in $name", ({ tools }) => {
		const command = tools().find((tool) => tool.type === "function" && tool.function.name === "execute_command")
		expect(command).toEqual(executeCommand)
		expect(command).toMatchObject({
			function: {
				strict: true,
				parameters: { required: ["command", "cwd", "timeout"] },
			},
		})
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
