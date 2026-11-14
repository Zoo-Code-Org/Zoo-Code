// npx vitest run core/tools/__tests__/applyDiffTool.guardedPublish.spec.ts

/**
 * Regression cover for the e2e-mock leg going red at 59b5b10ea6 (pull 2444): apply_diff still
 * called saveChanges() and saveDirectly() with the pre-guard argument lists, so its targeted-
 * hunk publish inherited the full-file defaults ("update" and "create") while the only
 * observation in play was a partial one. The guard refused the approved patch with "File was
 * only partially read ... re-read the whole file, then retry.", the tool result lost the
 * path-and-operation payload the recorded mock conversation answers to, and every apply_diff
 * scenario burned its timeout in a fixture-mismatch retry loop inside the extension host.
 *
 * This pins the seam at the tool: which guard a publish selects, and that the tool's own read -
 * not the preview - is what the compare-and-swap runs against.
 */

import fs from "fs/promises"
import path from "path"
import type { BigIntStats } from "fs"

import type { MockedFunction } from "vitest"

import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { applyDiffTool } from "../ApplyDiffTool"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

// ApplyDiffTool reads through the default export and stats around that read for its version
// token; guardedWrite resolves the same module as a namespace import, so realpath has to exist
// as a named export as well as on the default object. The two stats return the same record so
// the read is verifiably one unchanged version, which is the case the code observes.
vi.mock("fs/promises", () => ({
	realpath: vi.fn(async (p: string) => String(p)),
	lstat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
	stat: vi.fn(),
	access: vi.fn(),
	mkdir: vi.fn(),
	unlink: vi.fn(),
	writeFile: vi.fn(),
	default: {
		readFile: vi.fn().mockResolvedValue("old\n"),
		stat: vi.fn(),
		realpath: vi.fn(async (p: string) => String(p)),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn((_cwd: string, relPath?: string) => relPath ?? ""),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../services/file-safety/safeWriteText", () => ({
	safeWriteText: vi.fn(),
	resolveLockKey: vi.fn(async (p: string) => p),
}))

vi.mock("../../../utils/fileLock", () => ({
	withFileLock: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((message: string) => `Error: ${message}`),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

const CWD = "/workspace"
const REL_PATH = "src/index.ts"
const ABSOLUTE_PATH = path.resolve(CWD, REL_PATH)
const DIFF = "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"
const READ_TOKEN = "1:2:4:10:11"

// The five bigint fields versionTokenOfStat renders; the rest of BigIntStats is never read here,
// so the record is asserted structurally rather than built field by field - a last-resort double
// assertion, because BigIntStats has no constructor and every other field is irrelevant here.
const READ_STATS = {
	dev: 1n,
	ino: 2n,
	size: 4n,
	mtimeNs: 10n,
	ctimeNs: 11n,
	isSymbolicLink: () => false,
} as unknown as BigIntStats

// The module default carries the doubles the tool sees; the assertion site needs them as mocks.
const fsDouble = fs as unknown as {
	readFile: MockedFunction<(p: string, enc: string) => Promise<string>>
	stat: MockedFunction<(p: string, o: { bigint: true }) => Promise<BigIntStats>>
}

type SaveChangesDouble = MockedFunction<
	(
		diagnosticsEnabled: boolean,
		writeDelayMs: number,
		writeKind?: string,
		approvedOutsideWorkspace?: boolean,
		approvedCanonicalTarget?: string,
	) => Promise<unknown>
>
type SaveDirectlyDouble = MockedFunction<
	(
		relPath: string,
		content: string,
		openFile: boolean,
		diagnosticsEnabled: boolean,
		writeDelayMs: number,
		writeKind?: string,
		completeOverride?: boolean,
		approvedOutsideWorkspace?: boolean,
		approvedCanonicalTarget?: string,
	) => Promise<unknown>
>

const SAVED = { newProblemsMessage: undefined, userEdits: undefined, finalContent: "new\n" }

function createHarness(preventFocusDisruption = false, priorObservation?: { version: string; complete: boolean }) {
	const saveChanges = vi.fn<SaveChangesDouble>().mockResolvedValue(SAVED)
	const saveDirectly = vi.fn<SaveDirectlyDouble>().mockResolvedValue(SAVED)
	const observe = vi.fn<(absolutePath: string, version: string, complete: boolean) => void>()
	const get = vi
		.fn<(absolutePath: string) => { version: string; complete: boolean } | undefined>()
		.mockReturnValue(priorObservation)
	const toolTask = {
		cwd: CWD,
		consecutiveMistakeCount: 0,
		consecutiveMistakeCountForApplyDiff: new Map<string, number>(),
		didEditFile: false,
		api: { getModel: () => ({ id: "claude-test" }) },
		rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
		rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		observationRegistry: {
			get,
			observe,
			has: vi.fn<(absolutePath: string) => boolean>().mockReturnValue(priorObservation !== undefined),
			forget: vi.fn<(absolutePath: string) => boolean>().mockReturnValue(false),
		},
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: false,
					writeDelayMs: 0,
					experiments: { preventFocusDisruption },
				}),
			}),
		},
		diffStrategy: {
			getName: () => "test",
			applyDiff: vi.fn().mockResolvedValue({ success: true, content: "new\n" }),
		},
		diffViewProvider: {
			editType: undefined,
			originalContent: "",
			open: vi.fn<(relPath: string) => Promise<void>>().mockResolvedValue(undefined),
			update: vi.fn<(content: string, streaming: boolean) => Promise<void>>().mockResolvedValue(undefined),
			reset: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			revertChanges: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			saveChanges,
			saveDirectly,
			scrollToFirstDiff: vi.fn<(lineCount?: number, showDiff?: boolean) => void>(),
			pushToolWriteResult: vi
				.fn<(task: Task, cwd: string, isNewFile: boolean) => Promise<string>>()
				.mockResolvedValue(JSON.stringify({ path: REL_PATH, operation: "modified", notice: "" })),
		},
		fileContextTracker: {
			trackFileContext: vi.fn<(path: string, source: string) => Promise<void>>().mockResolvedValue(undefined),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue(undefined),
		recordToolError: vi.fn(),
		processQueuedMessages: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
	}
	// A typed Task would require stubbing every member the class owns; this double carries only
	// what ApplyDiffTool.execute reads, so the cast stays at the boundary with the mocks exposed.
	const task = toolTask as unknown as Task
	return { task, saveChanges, saveDirectly, observe, get }
}

async function runExecute(task: Task): Promise<void> {
	const askApproval = vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true)
	await applyDiffTool.execute({ path: REL_PATH, diff: DIFF }, task, {
		askApproval,
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
		toolCallId: "tool-call-1",
	} satisfies ToolCallbacks)
}

describe("ApplyDiffTool guarded publish", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		fsDouble.readFile.mockResolvedValue("old\n")
		fsDouble.stat.mockResolvedValue(READ_STATS)
		applyDiffTool.resetPartialState()
	})

	it("selects the edit guard on the diff-view save", async () => {
		const { task, saveChanges, saveDirectly } = createHarness()
		await runExecute(task)
		expect(saveChanges).toHaveBeenCalledTimes(1)
		// Third argument is the guarded-write kind. The full-file default refuses a publish built
		// from a patch, which is what threw the four apply_diff e2e scenarios into a retry loop.
		expect(saveChanges.mock.calls[0][2]).toBe("edit")
		expect(saveDirectly).not.toHaveBeenCalled()
	})

	it("selects the edit guard on the preventFocusDisruption save", async () => {
		const { task, saveChanges, saveDirectly } = createHarness(true)
		await runExecute(task)
		expect(saveDirectly).toHaveBeenCalledTimes(1)
		// Sixth argument is the guarded-write kind and the seventh is completeOverride, which this
		// call must not claim: the model has seen the patch's hunks only.
		expect(saveDirectly.mock.calls[0][5]).toBe("edit")
		expect(saveDirectly.mock.calls[0][6]).toBeUndefined()
		expect(saveChanges).not.toHaveBeenCalled()
	})

	it("records its own read as an incomplete observation, so the save compares against it", async () => {
		const { task, observe } = createHarness()
		await runExecute(task)
		expect(observe).toHaveBeenCalledWith(ABSOLUTE_PATH, READ_TOKEN, false)
	})

	it("leaves an older observation exactly as the model earned it", async () => {
		const { task, observe, saveChanges } = createHarness(false, { version: "0:0:9:9:9", complete: true })
		await runExecute(task)
		// Refreshing a stale observation to the version this read saw would hand the guard a
		// compare-and-swap token for content the model never saw.
		expect(observe).not.toHaveBeenCalled()
		expect(saveChanges.mock.calls[0][2]).toBe("edit")
	})

	it("binds an approved outside-workspace target before the save", async () => {
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(true)
		const { task, saveChanges } = createHarness()
		await runExecute(task)
		expect(saveChanges).toHaveBeenCalledTimes(1)
		expect(saveChanges.mock.calls[0][2]).toBe("edit")
		// Fourth argument is the post-approval outside-workspace flag and the fifth the canonical
		// identity captured before the approval was asked.
		expect(saveChanges.mock.calls[0][3]).toBe(true)
		expect(saveChanges.mock.calls[0][4]).toBe(ABSOLUTE_PATH)
	})

	it("passes no approved target for an in-workspace save", async () => {
		const { task, saveChanges } = createHarness()
		await runExecute(task)
		expect(saveChanges.mock.calls[0][4]).toBeUndefined()
	})
})
