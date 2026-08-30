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
		const say = vi.fn(async (_say: string, _text?: string, ..._rest: unknown[]) => {})
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

	it("marks the display line isNonInteractive so a pending ask is never superseded (regression)", async () => {
		// Regression: setting the effort while the task was blocked on a pending ask
		// (e.g. the followup ask after a subtask returned) made say() bump lastMessageTs;
		// Task.ask's pWaitFor then resolved and threw AskIgnoredError("superseded"),
		// killing the request loop. The next user message reached
		// handleWebviewAskResponse with no waiter — no API call, frozen UI.
		// isNonInteractive keeps the display line out of the ask superseding flow.
		const task = makeTask(["low", "medium", "high"])
		const provider = makeProvider(task)

		await apply(provider, { type: "setTaskThinkingEffort", effort: "low" })

		// Task.say(type, text, images, partial, checkpoint, progressStatus, options)
		const options = task.say.mock.calls[0]?.[6]
		expect(options).toEqual({ isNonInteractive: true })
	})

	it("applies a task-local effort when the capability is boolean/adaptive-class (DTE regression)", async () => {
		// Boolean `true` is the adaptive class: it advertises the full canonical
		// effort set, so an active-task "high" selection applies exactly like the
		// array path. ("adaptive" itself is display-only in the composer — it is
		// not a canonical effort value and is never applied.)
		const task = makeTask(true)
		const provider = makeProvider(task)

		await apply(provider, { type: "setTaskThinkingEffort", effort: "high" })

		expect(task.setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "you")
		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})

	it.each([
		["an unsupported level", ["low", "medium", "high"], { effort: "max" }],
		// The capability array schema may advertise the UI-only "disable"
		// sentinel, but it is rejected by the canonical enum before the
		// capability check (DTE regression).
		["the advertised disable sentinel", ["disable", "low", "high", "max"], { effort: "disable" }],
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
		// "disable" is a UI sentinel, not a settable task-local effort: it must
		// never be parked for the next task either (DTE regression).
		["the disable sentinel", { effort: "disable" }],
	])("does not park %s when there is no current task", async (_name, message) => {
		const provider = makeProvider(undefined)

		await apply(provider, { type: "setTaskThinkingEffort", ...message })

		expect(provider.setPendingTaskThinkingEffort).not.toHaveBeenCalled()
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
	})
})
