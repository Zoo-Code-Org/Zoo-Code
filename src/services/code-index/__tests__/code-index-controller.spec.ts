import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"

import { CodeIndexController } from "../code-index-controller"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"

vi.mock("vscode", () => ({
	EventEmitter: class {
		private readonly listeners = new Set<(value: unknown) => void>()

		public readonly event = (listener: (value: unknown) => void) => {
			this.listeners.add(listener)
			return { dispose: () => this.listeners.delete(listener) }
		}

		public fire(value: unknown) {
			this.listeners.forEach((listener) => listener(value))
		}

		public dispose() {
			this.listeners.clear()
		}
	},
}))

function createCodeIndexDependencies(): {
	codeIndexManager: CodeIndexManager
	codeIndexStateManager: CodeIndexStateManager
} {
	const workspacePath = "/workspace"
	const codeIndexStateManager = new CodeIndexStateManager()
	const codeIndexManager = new CodeIndexManager(
		workspacePath,
		makeUri(workspacePath),
		makeExtensionContext(),
		codeIndexStateManager,
	)

	vi.spyOn(codeIndexManager, "initialize").mockResolvedValue({ requiresRestart: false })
	vi.spyOn(codeIndexManager, "handleSettingsChange").mockResolvedValue(undefined)
	vi.spyOn(codeIndexManager, "startIndexing").mockResolvedValue(undefined)
	vi.spyOn(codeIndexManager, "stopIndexing").mockImplementation(() => undefined)
	vi.spyOn(codeIndexManager, "setWorkspaceEnabled").mockResolvedValue(undefined)
	vi.spyOn(codeIndexManager, "setAutoEnableDefault").mockResolvedValue(undefined)
	vi.spyOn(codeIndexManager, "clearIndexData").mockResolvedValue(undefined)

	return { codeIndexManager, codeIndexStateManager }
}

describe("CodeIndexController", () => {
	it("delegates interface commands directly to the code index manager", async () => {
		const { codeIndexManager, codeIndexStateManager } = createCodeIndexDependencies()
		const contextProxy = {} as ContextProxy
		const codeIndexController = new CodeIndexController(codeIndexManager, codeIndexStateManager)

		await codeIndexController.initialize(contextProxy)
		await codeIndexController.handleSettingsChange()
		await codeIndexController.startIndexing()
		codeIndexController.stopIndexing()
		await codeIndexController.setWorkspaceEnabled(true)
		await codeIndexController.setAutoEnableDefault(false)
		await codeIndexController.clearIndexData()

		expect(codeIndexManager.initialize).toHaveBeenCalledWith(contextProxy)
		expect(codeIndexManager.handleSettingsChange).toHaveBeenCalledTimes(1)
		expect(codeIndexManager.startIndexing).toHaveBeenCalledTimes(1)
		expect(codeIndexManager.stopIndexing).toHaveBeenCalledTimes(1)
		expect(codeIndexManager.setWorkspaceEnabled).toHaveBeenCalledWith(true)
		expect(codeIndexManager.setAutoEnableDefault).toHaveBeenCalledWith(false)
		expect(codeIndexManager.clearIndexData).toHaveBeenCalledTimes(1)
	})

	it("combines indexing state with workspace settings", () => {
		const { codeIndexManager, codeIndexStateManager } = createCodeIndexDependencies()
		vi.spyOn(codeIndexManager, "autoEnableDefault", "get").mockReturnValue(false)
		vi.spyOn(codeIndexManager, "isWorkspaceEnabled", "get").mockReturnValue(false)
		vi.spyOn(codeIndexStateManager, "getCurrentStatus").mockReturnValue({
			systemStatus: "Standby",
			message: "Ready",
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "blocks",
		})
		const codeIndexController = new CodeIndexController(codeIndexManager, codeIndexStateManager)

		expect(codeIndexController.codeIndexState).toEqual({
			systemStatus: "Standby",
			message: "Ready",
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "blocks",
			workspacePath: "/workspace",
			workspaceEnabled: false,
			autoEnableDefault: false,
		})
		expect(codeIndexController.getCurrentStatus()).toEqual(codeIndexController.codeIndexState)
	})

	it("emits complete view state when indexing progress changes", () => {
		const { codeIndexManager, codeIndexStateManager } = createCodeIndexDependencies()
		vi.spyOn(codeIndexManager, "autoEnableDefault", "get").mockReturnValue(true)
		vi.spyOn(codeIndexManager, "isWorkspaceEnabled", "get").mockReturnValue(true)
		const codeIndexController = new CodeIndexController(codeIndexManager, codeIndexStateManager)
		const listener = vi.fn()
		codeIndexController.onDidChangeCodeIndexState(listener)

		codeIndexStateManager.setSystemState("Indexing", "Scanning")

		expect(listener).toHaveBeenCalledWith({
			systemStatus: "Indexing",
			message: "Scanning",
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "blocks",
			workspacePath: "/workspace",
			workspaceEnabled: true,
			autoEnableDefault: true,
		})
	})

	it("emits state after workspace settings change", async () => {
		const { codeIndexManager, codeIndexStateManager } = createCodeIndexDependencies()
		const codeIndexController = new CodeIndexController(codeIndexManager, codeIndexStateManager)
		const listener = vi.fn()
		codeIndexController.onDidChangeCodeIndexState(listener)

		await codeIndexController.setWorkspaceEnabled(false)
		await codeIndexController.setAutoEnableDefault(false)

		expect(listener).toHaveBeenCalledTimes(2)
	})
})
