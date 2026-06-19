import { describe, it, expect, vi, beforeEach } from "vitest"
import { FileContextTracker } from "../FileContextTracker"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	Uri: { file: vi.fn((p: string) => ({ fsPath: p })) },
	RelativePattern: vi.fn(),
}))

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/storage/task-1"),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", () => ({
	default: { readFile: vi.fn() },
}))

vi.mock("path", async () => {
	const actual = await vi.importActual<typeof import("path")>("path")
	return { ...actual, default: actual }
})

describe("FileContextTracker.addFileToFileContextTracker", () => {
	let tracker: FileContextTracker
	const mockProvider = {
		contextProxy: {
			globalStorageUri: { fsPath: "/storage" },
		},
	} as any

	beforeEach(() => {
		vi.clearAllMocks()
		tracker = new FileContextTracker(mockProvider, "task-1")
	})

	it("creates a new active entry with record_source set to the given source", async () => {
		const { safeWriteJson } = await import("../../../utils/safeWriteJson")
		const mockWrite = vi.mocked(safeWriteJson)

		await tracker.addFileToFileContextTracker("task-1", "/workspace/foo.ts", "read_tool")

		expect(mockWrite).toHaveBeenCalledOnce()
		const written = mockWrite.mock.calls[0][1] as any
		const entry = written.files_in_context[0]
		expect(entry.path).toBe("/workspace/foo.ts")
		expect(entry.record_state).toBe("active")
		expect(entry.record_source).toBe("read_tool")
		expect(entry.roo_read_date).toBeTypeOf("number")
	})

	it("marks existing active entries as stale before adding the new entry", async () => {
		const { fileExistsAtPath } = await import("../../../utils/fs")
		const fs = await import("fs/promises")
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.default.readFile).mockResolvedValue(
			JSON.stringify({
				files_in_context: [{ path: "/workspace/foo.ts", record_state: "active", record_source: "read_tool" }],
			}) as any,
		)

		const { safeWriteJson } = await import("../../../utils/safeWriteJson")
		const mockWrite = vi.mocked(safeWriteJson)

		await tracker.addFileToFileContextTracker("task-1", "/workspace/foo.ts", "roo_edited")

		const written = mockWrite.mock.calls[0][1] as any
		expect(written.files_in_context[0].record_state).toBe("stale")
		expect(written.files_in_context[1].record_state).toBe("active")
	})
})
