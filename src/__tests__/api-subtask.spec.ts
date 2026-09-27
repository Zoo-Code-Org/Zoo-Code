// npx vitest run __tests__/api-subtask.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "events"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [] },
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	env: { language: "en" },
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p })),
		parse: vi.fn((s: string) => ({ toString: () => s })),
	},
	commands: { registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
}))

vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {
		listen() {}
		on() {}
		close() {}
	},
}))

vi.mock("../services/command/commands", () => ({ getCommands: vi.fn().mockResolvedValue([]) }))

import { API } from "../extension/api"

function makeProviderMock() {
	const emitter = new EventEmitter()
	return {
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		emit: emitter.emit.bind(emitter),
		context: {
			extensionPath: "/test",
			globalStorageUri: { fsPath: "/test/storage" },
			subscriptions: [],
		},
		cwd: "/test/cwd",
		evictCurrentTask: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		abandonSubtask: vi.fn().mockResolvedValue(true),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		viewLaunched: false,
		cancelTask: vi.fn().mockResolvedValue(undefined),
		getTaskWithId: vi.fn().mockRejectedValue(new Error("not found")),
		taskHistoryStore: { get: vi.fn().mockReturnValue(undefined), getAll: vi.fn().mockReturnValue([]) },
		getCurrentTaskStack: vi.fn().mockReturnValue([]),
		getModes: vi.fn().mockResolvedValue([]),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
	}
}

describe("API.clearCurrentTask()", () => {
	let provider: ReturnType<typeof makeProviderMock>
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		provider = makeProviderMock()
		api = new API({} as any, provider as any)
	})

	it("calls evictCurrentTask then postStateToWebview on sidebarProvider", async () => {
		await api.clearCurrentTask()
		expect(provider.evictCurrentTask).toHaveBeenCalledTimes(1)
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
		// evict must come before postState
		const evictOrder = provider.evictCurrentTask.mock.invocationCallOrder[0]
		const postOrder = provider.postStateToWebview.mock.invocationCallOrder[0]
		expect(evictOrder).toBeLessThan(postOrder)
	})
})

describe("API.abandonSubtask()", () => {
	let provider: ReturnType<typeof makeProviderMock>
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		provider = makeProviderMock()
		api = new API({} as any, provider as any)
	})

	it("delegates to sidebarProvider.abandonSubtask and returns its result", async () => {
		provider.abandonSubtask.mockResolvedValue(true)
		const result = await api.abandonSubtask("child-task-1")
		expect(provider.abandonSubtask).toHaveBeenCalledWith("child-task-1")
		expect(result).toBe(true)
	})

	it("returns false when sidebarProvider.abandonSubtask returns false", async () => {
		provider.abandonSubtask.mockResolvedValue(false)
		const result = await api.abandonSubtask("child-task-2")
		expect(result).toBe(false)
	})
})
