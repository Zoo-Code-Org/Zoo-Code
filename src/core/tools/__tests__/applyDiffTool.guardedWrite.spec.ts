// npx vitest run core/tools/__tests__/applyDiffTool.guardedWrite.spec.ts

import path from "path"
import type { BigIntStats } from "fs"
import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { ObservationRegistry } from "../../task/observationRegistry"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		stat: vi.fn().mockResolvedValue({
			dev: 7n,
			ino: 4242n,
			size: 1234n,
			mtimeNs: 1700000000123456789n,
			ctimeNs: 1700000000789999999n,
		}),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

describe("ApplyDiffTool.execute - guarded write (S4b, epic #1375)", () => {
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>

	let tool: ApplyDiffTool
	let mockTask: Pick<
		Task,
		| "cwd"
		| "consecutiveMistakeCount"
		| "consecutiveMistakeCountForApplyDiff"
		| "recordToolError"
		| "rooIgnoreController"
		| "rooProtectedController"
		| "say"
		| "processQueuedMessages"
		| "didEditFile"
		| "api"
		| "diffStrategy"
		| "diffViewProvider"
		| "providerRef"
		| "fileContextTracker"
		| "observationRegistry"
	>
	let mockSaveDirectly: MockedFunction<(...args: unknown[]) => Promise<unknown>>
	let mockAskApproval: MockedFunction<(...args: unknown[]) => Promise<boolean>>
	let mockHandleError: MockedFunction<(...args: unknown[]) => Promise<void>>
	let mockPushToolResult: MockedFunction<(...args: unknown[]) => void>

	beforeEach(() => {
		vi.clearAllMocks()

		mockedFileExistsAtPath.mockResolvedValue(true)

		mockSaveDirectly = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})

		// Structural stubs for the guarded-write path: the real DiffViewProvider is
		// out of scope here, so vi.fn() doubles stand in for the members the tool
		// touches (the saveDirectly double also records the writeKind plumbing).
		const diffViewProviderStub = {
			editType: undefined as "create" | "modify" | undefined,
			originalContent: undefined as string | undefined,
			saveDirectly: mockSaveDirectly,
			pushToolWriteResult: vi.fn().mockResolvedValue("Saved file"),
			reset: vi.fn().mockResolvedValue(undefined),
		}
		mockTask = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			consecutiveMistakeCountForApplyDiff: new Map(),
			recordToolError: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			} as unknown as Task["rooIgnoreController"],
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			} as unknown as Task["rooProtectedController"],
			say: vi.fn().mockResolvedValue(undefined),
			processQueuedMessages: vi.fn(),
			didEditFile: false,
			api: {
				getModel: () => ({ id: "claude-sonnet-4-5" }),
			} as unknown as Task["api"],
			diffStrategy: {
				applyDiff: vi.fn().mockResolvedValue({ success: true, content: "modified file content\n" }),
			} as unknown as Task["diffStrategy"],
			diffViewProvider: diffViewProviderStub as unknown as Task["diffViewProvider"],
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						// Exercise the focus-disruption (saveDirectly) save path.
						experiments: { preventFocusDisruption: true },
					}),
				}),
			} as unknown as Task["providerRef"],
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			} as unknown as Task["fileContextTracker"],
			// Real registry: the point of these tests is which version token ends up
			// recorded, so a stub would only restate the call.
			observationRegistry: new ObservationRegistry(),
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)
		mockPushToolResult = vi.fn()

		tool = new ApplyDiffTool()
	})

	it("publishes through the guarded saveDirectly with edit kind", async () => {
		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
		expect(mockPushToolResult).toHaveBeenCalledWith("Saved file")
		expect(mockTask.didEditFile).toBe(true)
		expect(mockHandleError).not.toHaveBeenCalled()
	})

	it("surfaces the unobserved edit remediation as a tool error", async () => {
		const guardError = new Error("File not read yet -- read the file, then retry.")
		mockSaveDirectly.mockRejectedValue(guardError)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockHandleError).toHaveBeenCalledWith("applying diff", guardError)
		expect(vi.mocked(mockTask.diffViewProvider.reset)).toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
	})
	it("records the version the diff was computed against so the guarded edit is authorized", async () => {
		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// The focus-disruption save has no diff view to observe the file, so the tool read
		// itself must leave an observation for the version the hunks were computed against -
		// otherwise saveDirectly("edit") rejects with "File not read yet".
		const observed = mockTask.observationRegistry.get(path.resolve("/workspace/project", "src/thing.ts"))
		expect(observed?.version).toBe("7:4242:1234:1700000000123456789:1700000000789999999")
		expect(mockSaveDirectly).toHaveBeenCalledWith(
			"src/thing.ts",
			"modified file content\n",
			false,
			true,
			1000,
			"edit",
		)
	})

	it("does not observe when the file changes underneath the read", async () => {
		// Only the fields versionTokenOfStat reads; a full BigIntStats cannot be built
		// against the mocked fs, so the double assertion is the narrowest option.
		const statMock = vi.mocked((await import("fs/promises")).default.stat)
		statMock
			.mockResolvedValueOnce(
				{ dev: 7n, ino: 4242n, size: 1234n, mtimeNs: 1n, ctimeNs: 2n } as unknown as BigIntStats,
			)
			.mockResolvedValueOnce(
				{ dev: 7n, ino: 4242n, size: 9999n, mtimeNs: 3n, ctimeNs: 4n } as unknown as BigIntStats,
			)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// A read that straddled a write proves nothing about the current version, so no
		// observation may be recorded and the guarded publish keeps its remediation.
		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)

	})
	it.each(["pre-read", "post-read"])(
		"continues the read and records no observation when the %s stat fails",
		async (which) => {
			const statMock = vi.mocked((await import("fs/promises")).default.stat)
			const stable = {
				dev: 7n,
				ino: 4242n,
				size: 1234n,
				mtimeNs: 1700000000123456789n,
				ctimeNs: 1700000000789999999n,
			} as unknown as BigIntStats
			const failure = new Error("EACCES: permission denied")
			if (which === "pre-read") {
				statMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(stable)
			} else {
				statMock.mockResolvedValueOnce(stable).mockRejectedValueOnce(failure)
			}

			// With no observation the guarded publish refuses, which is what the second half
			// of this assertion checks.
			const guardError = new Error("File not read yet -- read the file, then retry.")
			mockSaveDirectly.mockRejectedValue(guardError)

			await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Both stat calls must be consumed: beforeEach only clears call history, so a
			// queued mockResolvedValueOnce would leak into the next test if the tool ever
			// skipped one of the reads.
			expect(statMock).toHaveBeenCalledTimes(2)

			// A stat failure is not evidence the file changed and not a reason to abort: the
			// diff still ran against the content that WAS read successfully.
			expect(mockSaveDirectly).toHaveBeenCalledWith(
				"src/thing.ts",
				"modified file content\n",
				false,
				true,
				1000,
				"edit",
			)
			// Nothing may be observed from a read whose version is unknown.
			expect(
				mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts")),
			).toBe(false)
			// And the refused publish surfaces as an error rather than a saved file.
			expect(mockHandleError).toHaveBeenCalledWith("applying diff", guardError)
			expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
		},
	)
})
