import type { Mock } from "vitest"
import * as vscode from "vscode"
import WorkspaceTracker from "../WorkspaceTracker"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { listFiles } from "../../../services/glob/list-files"
import { getTaskCwdPath, getWorkspacePath } from "../../../utils/path"

// Mock functions - must be defined before vitest.mock calls
const mockOnDidCreate = vitest.fn()
const mockOnDidDelete = vitest.fn()
const mockDispose = vitest.fn()

// Store registered tab change callback
let registeredTabChangeCallback: (() => Promise<void>) | null = null

// Mock workspace path
vitest.mock("../../../utils/path", () => ({
	getWorkspacePath: vitest.fn().mockReturnValue("/test/workspace"),
	getTaskCwdPath: vitest.fn().mockReturnValue("/anchor/dir"),
	toRelativePath: vitest.fn(function (path, cwd) {
		// Handle both Windows and POSIX paths by using path.relative
		const relativePath = require("path").relative(cwd, path)
		// Convert to forward slashes for consistency
		const normalizedPath = relativePath.replace(/\\/g, "/")
		// Add trailing slash if original path had one
		return path.endsWith("/") ? normalizedPath + "/" : normalizedPath
	}),
}))

// Mock watcher - must be defined after mockDispose but before vitest.mock("vscode")
const mockWatcher = {
	onDidCreate: mockOnDidCreate.mockReturnValue({ dispose: mockDispose }),
	onDidDelete: mockOnDidDelete.mockReturnValue({ dispose: mockDispose }),
	dispose: mockDispose,
}

// Mock vscode
vitest.mock("vscode", () => ({
	window: {
		tabGroups: {
			onDidChangeTabs: vitest.fn(function (callback) {
				registeredTabChangeCallback = callback
				return { dispose: mockDispose }
			}),
			all: [],
		},
		onDidChangeActiveTextEditor: vitest.fn(function () {
			return { dispose: vitest.fn() }
		}),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: { fsPath: "/test/workspace" },
				name: "test",
				index: 0,
			},
		],
		createFileSystemWatcher: vitest.fn(function () {
			return mockWatcher
		}),
		fs: {
			stat: vitest.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
		},
	},
	FileType: { File: 1, Directory: 2 },
	TabInputText: class MockTabInputText {},
}))

vitest.mock("../../../services/glob/list-files", () => ({
	listFiles: vitest.fn(),
}))

describe("WorkspaceTracker", () => {
	let workspaceTracker: WorkspaceTracker
	let mockProvider: ClineProvider

	beforeEach(() => {
		vitest.clearAllMocks()
		vitest.useFakeTimers()

		// Reset all mock implementations
		registeredTabChangeCallback = null

		// Reset workspace path mock
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create provider mock
		mockProvider = {
			postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider & { postMessageToWebview: Mock }

		// Create tracker instance
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Ensure the tab change callback was registered
		expect(registeredTabChangeCallback).not.toBeNull()
	})

	afterEach(() => {
		workspaceTracker.dispose()
		vitest.runOnlyPendingTimers()
		vitest.useRealTimers()
	})

	it("should initialize with workspace files", async () => {
		const mockFiles = [["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(["file1.ts", "file2.ts"]),
			openedTabs: [],
		})
		expect((mockProvider.postMessageToWebview as Mock).mock.calls[0][0].filePaths).toHaveLength(2)
	})

	it("should handle file creation events", async () => {
		// Get the creation callback and call it
		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newfile.ts" })
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: ["newfile.ts"],
			openedTabs: [],
		})
	})

	it("should handle file deletion events", async () => {
		// First add a file
		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// Then delete it
		const [[deleteCallback]] = mockOnDidDelete.mock.calls
		await deleteCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// The last call should have empty filePaths
		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
	})

	it("should handle directory paths correctly", async () => {
		// Mock stat to return directory type
		;(vscode.workspace.fs.stat as Mock).mockResolvedValueOnce({ type: 2 }) // FileType.Directory = 2

		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newdir" })
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(["newdir"]),
			openedTabs: [],
		})
		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(1)
	})

	it("should respect file limits", async () => {
		// Create array of unique file paths for initial load
		const files = Array.from({ length: 1001 }, (_, i) => `/test/workspace/file${i}.ts`)
		;(listFiles as Mock).mockResolvedValue([files, false])

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		// Should only have 1000 files initially
		const expectedFiles = Array.from({ length: 1000 }, (_, i) => `file${i}.ts`).sort()
		const calls = (mockProvider.postMessageToWebview as Mock).mock.calls

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(expectedFiles),
			openedTabs: [],
		})
		expect(calls[0][0].filePaths).toHaveLength(1000)

		// Should allow adding up to 2000 total files
		const [[callback]] = mockOnDidCreate.mock.calls
		for (let i = 0; i < 1000; i++) {
			await callback({ fsPath: `/test/workspace/extra${i}.ts` })
		}
		vitest.runAllTimers()

		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(2000)

		// Adding one more file beyond 2000 should not increase the count
		await callback({ fsPath: "/test/workspace/toomany.ts" })
		vitest.runAllTimers()

		const finalCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(finalCall[0].filePaths).toHaveLength(2000)
	})

	it("should clean up watchers and timers on dispose", () => {
		// Set up updateTimer
		const [[callback]] = mockOnDidCreate.mock.calls
		callback({ fsPath: "/test/workspace/file.ts" })

		workspaceTracker.dispose()
		expect(mockDispose).toHaveBeenCalled()
		vitest.runAllTimers() // Ensure any pending timers are cleared

		// No more updates should happen after dispose
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should handle workspace path changes when tabs change", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path and create tracker
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Clear any initialization calls
		vitest.clearAllMocks()

		// Mock listFiles to return some files
		const mockFiles = [["/test/new-workspace/file1.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		// Change workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Simulate tab change event
		await registeredTabChangeCallback!()

		// Run the debounce timer for workspaceDidReset
		vitest.advanceTimersByTime(300)

		// Should clear file paths and reset workspace
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})

		// Run all remaining timers to complete initialization
		await Promise.resolve() // Wait for initializeFilePaths to complete
		vitest.runAllTimers()

		// Should initialize file paths for new workspace
		expect(listFiles).toHaveBeenCalledWith("/test/new-workspace", true, 1000)
		vitest.runAllTimers()
	})

	it("should catch workspace reinitialization failures after a path change", async () => {
		const initializationError = new Error("workspace scan failed")
		const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => undefined)
		;(listFiles as Mock).mockRejectedValue(initializationError)
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		await registeredTabChangeCallback!()
		await vitest.advanceTimersByTimeAsync(300)

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[WorkspaceTracker] Failed to reset workspace:",
			initializationError,
		)
		consoleErrorSpy.mockRestore()
	})

	it("should not update file paths if workspace changes during initialization", async () => {
		// Setup initial workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Clear any initialization calls
		vitest.clearAllMocks()
		;(mockProvider.postMessageToWebview as Mock).mockClear()

		// Create a promise to control listFiles timing
		let resolveListFiles: (value: [string[], boolean]) => void
		const listFilesPromise = new Promise<[string[], boolean]>((resolve) => {
			resolveListFiles = resolve
		})

		// Setup listFiles to use our controlled promise
		;(listFiles as Mock).mockImplementation(function () {
			// Change workspace path before listFiles resolves
			;(getWorkspacePath as Mock).mockReturnValue("/test/changed-workspace")
			return listFilesPromise
		})

		// Start initialization
		const initPromise = workspaceTracker.initializeFilePaths()

		// Resolve listFiles after workspace path change
		resolveListFiles!([["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false])

		// Wait for initialization to complete
		await initPromise
		vitest.runAllTimers()

		// Should not update file paths because workspace changed during initialization
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "workspaceUpdated",
				openedTabs: [],
			}),
		)

		// Extract the actual file paths to verify format
		const actualFilePaths = (mockProvider.postMessageToWebview as Mock).mock.calls[0][0].filePaths

		// Verify file path array length
		expect(actualFilePaths).toHaveLength(2)

		// Verify file paths contain the expected file names regardless of platform specifics
		expect(actualFilePaths.every((path: string) => path.includes("file1.ts") || path.includes("file2.ts"))).toBe(
			true,
		)
	})

	it("should clear resetTimer when calling workspaceDidReset multiple times", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create tracker instance to set initial prevWorkSpacePath
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Change workspace path to trigger update
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Call workspaceDidReset through tab change event
		await registeredTabChangeCallback!()

		// Call again before timer completes
		await registeredTabChangeCallback!()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should only have one call to postMessageToWebview
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("should handle dispose with active resetTimer", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Mock workspace path change to trigger resetTimer
		;(getWorkspacePath as Mock).mockReturnValueOnce("/test/workspace").mockReturnValueOnce("/test/new-workspace")

		// Trigger resetTimer
		await registeredTabChangeCallback!()

		// Dispose before timer completes
		workspaceTracker.dispose()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should have called dispose on all disposables
		expect(mockDispose).toHaveBeenCalled()

		// No postMessage should be called after dispose
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// Issue #1271: without a workspace root there is no root to cut tab paths
	// against. Mention values must be relative to the task anchor so
	// parseMentions resolves them back to the open files.
	it("cuts opened-tab mention values against the task anchor without a workspace", async () => {
		const TabInputText = (vscode as unknown as { TabInputText: new () => object }).TabInputText
		const makeTab = (fsPath: string, isActive: boolean) => ({
			label: fsPath.split("/").pop() ?? "",
			isActive,
			input: Object.assign(new TabInputText(), { uri: { fsPath } }),
		})

		;(getWorkspacePath as Mock).mockReturnValue("")
		;(getTaskCwdPath as Mock).mockReturnValue("/anchor/dir")
		const tabGroupsMock = vscode.window.tabGroups as unknown as { all: unknown }
		const previousTabs = tabGroupsMock.all
		tabGroupsMock.all = [{ tabs: [makeTab("/anchor/dir/a.ts", true), makeTab("/elsewhere/b.ts", false)] }]

		try {
			await registeredTabChangeCallback!()
			vitest.runAllTimers()

			const calls = (mockProvider.postMessageToWebview as Mock).mock.calls
			const posted = calls.map((call) => call[0]).find((message) => message.openedTabs?.length === 2)
			expect(posted).toBeDefined()
			expect(posted.openedTabs.map((tab: { path: string }) => tab.path)).toEqual(["a.ts", "../../elsewhere/b.ts"])
		} finally {
			tabGroupsMock.all = previousTabs
		}
	})

	// Review round 2: a session that starts without a workspace keeps
	// prevWorkSpacePath equal to cwd, so tab changes take workspaceDidUpdate,
	// not workspaceDidReset. Directory scanning stays off, but every tab
	// update must still publish the opened tabs (cut against the task
	// anchor) with an empty file list, or the webview never sees any tabs.
	it("publishes opened tabs on repeated tab updates without a workspace", async () => {
		const TabInputText = (vscode as unknown as { TabInputText: new () => object }).TabInputText
		const makeTab = (fsPath: string, isActive: boolean) => ({
			label: fsPath.split("/").pop() ?? "",
			isActive,
			input: Object.assign(new TabInputText(), { uri: { fsPath } }),
		})

		// Rootless from construction: prevWorkSpacePath and cwd are both empty.
		;(getWorkspacePath as Mock).mockReturnValue("")
		;(getTaskCwdPath as Mock).mockReturnValue("/anchor/dir")
		workspaceTracker = new WorkspaceTracker(mockProvider)
		const tabGroupsMock = vscode.window.tabGroups as unknown as { all: unknown }
		const previousTabs = tabGroupsMock.all
		tabGroupsMock.all = [{ tabs: [makeTab("/anchor/dir/a.ts", true)] }]

		try {
			await registeredTabChangeCallback!()
			vitest.runAllTimers()

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "workspaceUpdated",
				filePaths: [],
				openedTabs: [{ label: "a.ts", isActive: true, path: "a.ts" }],
			})

			// A second tab change publishes again.
			tabGroupsMock.all = [{ tabs: [makeTab("/anchor/dir/b.ts", true)] }]
			await registeredTabChangeCallback!()
			vitest.runAllTimers()

			expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "workspaceUpdated",
				filePaths: [],
				openedTabs: [{ label: "b.ts", isActive: true, path: "b.ts" }],
			})
		} finally {
			tabGroupsMock.all = previousTabs
		}
	})
})
