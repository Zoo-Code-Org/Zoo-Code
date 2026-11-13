// npx vitest run core/tools/__tests__/applyDiffTool.guardedWrite.spec.ts

import path from "path"
import type { BigIntStats } from "fs"
import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { ObservationRegistry } from "../../task/observationRegistry"
import type { Task } from "../../task/Task"
import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => ({
	realpath: vi.fn(async (p: string) => String(p)),
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
		| "didToolFailInCurrentTurn"
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
			didToolFailInCurrentTurn: false,
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
			toolCallId: "test-tool-call-id",
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
			toolCallId: "test-tool-call-id",
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
			toolCallId: "test-tool-call-id",
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

	it("refuses the direct save when the read produced no token and an earlier observation would authorize it", async () => {
		// The reviewer's scenario: an earlier read left this path observed, so the guarded
		// publish would find a token to compare against, while the read that built *this*
		// diff straddled a write and produced no token of its own. Saving now publishes
		// content this tool never observed at a version it can verify, authorized by an
		// observation that belongs to a different read.
		const absolutePath = path.resolve("/workspace/project", "src/thing.ts")
		const earlierToken = "7:4242:1234:1700000000123456789:1700000000789999999"
		mockTask.observationRegistry.observe(absolutePath, earlierToken)

		const statMock = vi.mocked((await import("fs/promises")).default.stat)
		statMock
			.mockResolvedValueOnce({
				dev: 7n,
				ino: 4242n,
				size: 1234n,
				mtimeNs: 1n,
				ctimeNs: 2n,
			} as unknown as BigIntStats)
			.mockResolvedValueOnce({
				dev: 7n,
				ino: 4242n,
				size: 9999n,
				mtimeNs: 3n,
				ctimeNs: 4n,
			} as unknown as BigIntStats)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).not.toHaveBeenCalled()
		const [reportedWhere, reportedError] = mockHandleError.mock.calls[0] ?? []
		expect(reportedWhere).toBe("applying diff")
		expect(reportedError instanceof Error ? reportedError.message : "").toContain("changed while it was being read")
		expect(vi.mocked(mockTask.diffViewProvider.reset)).toHaveBeenCalled()
		expect(mockTask.didEditFile).toBe(false)
		expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
		// The earlier read's observation is left alone: this row is about not publishing on
		// its authority, not about retiring it.
		expect(mockTask.observationRegistry.get(absolutePath)?.version).toBe(earlierToken)
	})
	it("does not observe when the file changes underneath the read", async () => {
		// Only the fields versionTokenOfStat reads; a full BigIntStats cannot be built
		// against the mocked fs, so the double assertion is the narrowest option.
		const statMock = vi.mocked((await import("fs/promises")).default.stat)
		statMock
			.mockResolvedValueOnce({
				dev: 7n,
				ino: 4242n,
				size: 1234n,
				mtimeNs: 1n,
				ctimeNs: 2n,
			} as unknown as BigIntStats)
			.mockResolvedValueOnce({
				dev: 7n,
				ino: 4242n,
				size: 9999n,
				mtimeNs: 3n,
				ctimeNs: 4n,
			} as unknown as BigIntStats)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
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
				toolCallId: "test-tool-call-id",
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
			expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
			// And the refused publish surfaces as an error rather than a saved file.
			expect(mockHandleError).toHaveBeenCalledWith("applying diff", guardError)
			expect(mockPushToolResult).not.toHaveBeenCalledWith("Saved file")
		},
	)

	it("leaves the registry empty when the diff fails to apply", async () => {
		// The read happened but no hunk landed. The token must not stay in the task-wide
		// registry, or a later write_to_file could spend this read's token on a
		// full-file overwrite of content the model never received.
		mockTask.diffStrategy = {
			applyDiff: vi.fn().mockResolvedValue({ success: false, error: "context mismatch" }),
		} as unknown as Task["diffStrategy"]

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
	})

	it("leaves the registry empty when the user rejects the diff", async () => {
		// A rejection publishes nothing, so the read's token must not authorize a later
		// write either.
		mockAskApproval.mockResolvedValueOnce(false)

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
	})

	it("leaves the registry empty after the diff-view save", async () => {
		// The diff-view branch saves through saveChanges(), which never consults the
		// registry, so the read must not leave a token behind for a later write_to_file
		// to spend on an unrelated overwrite.
		const diffViewStub = mockTask.diffViewProvider as unknown as Record<string, unknown>
		// open() records the text it read; an unchanged file yields the same content the
		// tool diffed against, so the stale-base guard lets the save through.
		diffViewStub.open = vi.fn().mockImplementation(async () => {
			diffViewStub.originalContent = "original file content\n"
		})
		diffViewStub.update = vi.fn().mockResolvedValue(undefined)
		diffViewStub.scrollToFirstDiff = vi.fn()
		diffViewStub.saveChanges = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		mockTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					// Diff-view save path: no focus-disruption experiment.
					experiments: {},
				}),
			}),
		} as unknown as Task["providerRef"]

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(diffViewStub.saveChanges).toHaveBeenCalled()
		expect(mockSaveDirectly).not.toHaveBeenCalled()
		expect(mockTask.observationRegistry.has(path.resolve("/workspace/project", "src/thing.ts"))).toBe(false)
	})

	it("refuses to save when the file changed between the read and the diff view opening", async () => {
		// The diff was computed against "original file content\n", but another writer
		// replaced the file before open() re-read it. Saving would publish the older diff
		// over that change while the guard checked the newer baseline.
		const diffViewStub = mockTask.diffViewProvider as unknown as Record<string, unknown>
		diffViewStub.open = vi.fn().mockImplementation(async () => {
			diffViewStub.originalContent = "written by another process\n"
		})
		diffViewStub.update = vi.fn().mockResolvedValue(undefined)
		diffViewStub.scrollToFirstDiff = vi.fn()
		diffViewStub.revertChanges = vi.fn().mockResolvedValue(undefined)
		diffViewStub.saveChanges = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		mockTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: {},
				}),
			}),
		} as unknown as Task["providerRef"]

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(diffViewStub.update).not.toHaveBeenCalled()
		expect(diffViewStub.saveChanges).not.toHaveBeenCalled()
		expect(diffViewStub.revertChanges).toHaveBeenCalled()
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)
		expect(mockPushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("changed after it was read for this diff"),
		)
	})
	it("retires the diff view observation for this path when it rejects a stale diff", async () => {
		// open() re-reads the file and records that newer version as the save baseline
		// (src/integrations/editor/DiffViewProvider.ts:149-157). When the tool then rejects
		// the diff as stale, the rollback retires the buffer but leaves that observation
		// current, and a later write_to_file - focus-disruption save enabled - can spend it
		// on an overwrite the model never read. Retiring it must not retire other paths.
		const absolutePath = path.resolve("/workspace/project", "src/thing.ts")
		const otherPath = path.resolve("/workspace/project", "src/other.ts")
		mockTask.observationRegistry.observe(otherPath, "7:4242:1234:1700000000123456789:1700000000789999999")

		const diffViewStub = mockTask.diffViewProvider as unknown as Record<string, unknown>
		diffViewStub.open = vi.fn().mockImplementation(async () => {
			diffViewStub.originalContent = "written by another process\n"
			// What production open() does after re-reading the file: observe the newer token.
			mockTask.observationRegistry.observe(absolutePath, "7:4242:1234:1700000000123456799:1700000000789000001")
		})
		diffViewStub.update = vi.fn().mockResolvedValue(undefined)
		diffViewStub.scrollToFirstDiff = vi.fn()
		diffViewStub.revertChanges = vi.fn().mockResolvedValue(undefined)
		diffViewStub.saveChanges = vi.fn().mockResolvedValue({
			newProblemsMessage: "",
			userEdits: undefined,
			finalContent: "new content",
		})
		mockTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: {},
				}),
			}),
		} as unknown as Task["providerRef"]

		await tool.execute({ path: "src/thing.ts", diff: "unified diff" }, mockTask as Task, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "test-tool-call-id",
		})

		expect(diffViewStub.update).not.toHaveBeenCalled()
		expect(diffViewStub.saveChanges).not.toHaveBeenCalled()
		expect(diffViewStub.revertChanges).toHaveBeenCalled()
		expect(mockTask.observationRegistry.has(absolutePath)).toBe(false)
		expect(mockTask.observationRegistry.has(otherPath)).toBe(true)
	})
})
