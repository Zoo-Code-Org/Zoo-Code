import { describe, it, expect, vi } from "vitest"

import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},
	Uri: {
		parse: vi.fn((str) => ({ toString: () => str })),
		file: vi.fn((path) => ({ fsPath: path })),
	},
}))

describe("webviewMessageHandler setTaskThinkingEffort (DTE series 4/5)", () => {
	const makeTask = (supportsReasoningEffort: unknown) => {
		const say = vi.fn(async (_say: string, _text?: string) => {})
		return {
			taskId: "test-task-id",
			api: { getModel: () => ({ id: "test-model", info: { supportsReasoningEffort } }) },
			setRuntimeThinkingEffort: vi.fn(),
			say,
		}
	}

	const makeProvider = (task: unknown) => ({
		getCurrentTask: vi.fn(() => task),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		setPendingTaskThinkingEffort: vi.fn(),
	})

	const apply = (provider: ReturnType<typeof makeProvider>, message: Record<string, unknown>) =>
		webviewMessageHandler(provider as never, message as never)

	it("applies a task-local effort for a supported level, records the chat line, and pushes state", async () => {
		const task = makeTask(["low", "medium", "high"])
		const provider = makeProvider(task)

		await apply(provider, { type: "setTaskThinkingEffort", effort: "high" })

		expect(task.setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "you")
		const [say, text] = task.say.mock.calls[0]
		expect(say).toBe("tool")
		expect(text).toBe(JSON.stringify({ tool: "thinkingEffort", effort: "high", source: "you" }))
		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})

	it("accepts boolean/adaptive-class capability", async () => {
		const provider = makeProvider(makeTask(true))

		await apply(provider, { type: "setTaskThinkingEffort", effort: "medium" })

		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})

	it.each([
		["an unsupported level", ["low", "medium", "high"], { effort: "max" }],
		["an effort outside the canonical enum", ["low", "medium", "high"], { effort: "bogus" }],
		["a missing effort", ["low", "medium", "high"], {}],
		["a model without effort support", false, { effort: "high" }],
	])("ignores %s", async (_name, capability, message) => {
		const task = makeTask(capability)
		const provider = makeProvider(task)

		await apply(provider, { type: "setTaskThinkingEffort", ...message })

		expect(task.setRuntimeThinkingEffort).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
	})

	it("parks a pending effort for the next task when there is no current task", async () => {
		const provider = makeProvider(undefined)

		await apply(provider, { type: "setTaskThinkingEffort", effort: "high" })

		expect(provider.setPendingTaskThinkingEffort).toHaveBeenCalledWith("high")
		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})

	it.each([
		["an effort outside the canonical enum", { effort: "bogus" }],
		["a missing effort", {}],
	])("does not park %s when there is no current task", async (_name, message) => {
		const provider = makeProvider(undefined)

		await apply(provider, { type: "setTaskThinkingEffort", ...message })

		expect(provider.setPendingTaskThinkingEffort).not.toHaveBeenCalled()
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
	})
})
