// npx vitest run core/tools/__tests__/writeToFileTool.guardedPublish.spec.ts

/**
 * Regression cover for the sibling defect named while repairing pull 2444s red e2e-mock leg
 * (tracking issue #2459): WriteToFileTool.ts published with the pre-guard argument lists -
 * saveDirectly with five arguments and saveChanges with two - so the guard kind came from a
 * signature default rather than from the operation, and the prevent-focus arm read the whole
 * file itself without recording an observation. With no observation in play guardedWrite takes
 * its never-read branch (guardedWrite.ts 674-682, createIfAbsent) and refuses a target that arm
 * had just read end to end. The existing spec asserts only that saveChanges was called and never
 * reads its arguments, so it passes with and without the fix.
 *
 * This pins the seam at the tool: the kind each publish arm names for itself, the observation
 * the prevent-focus read earns, that the read is vouched for only while the bracketing stats
 * agree, and that an approved outside-workspace identity is captured before the ask and threaded
 * into the publish that acts on the approval.
 */

import fs from "fs/promises"
import path from "path"
import type { BigIntStats } from "fs"

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { versionTokenOfStat } from "../../../utils/versionToken"
import { canonicalizeForApproval } from "../guardedWrite"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import type { ToolUse } from "../../../shared/tools"
import { writeToFileTool } from "../WriteToFileTool"

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	realpath: vi.fn(async (p: string) => String(p)),
	stat: vi.fn(),
	access: vi.fn(),
	mkdir: vi.fn(),
	unlink: vi.fn(),
	writeFile: vi.fn(),
	default: {
		readFile: vi.fn(),
		stat: vi.fn(),
		realpath: vi.fn(async (p: string) => String(p)),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn((_cwd: string, relPath?: string) => relPath ?? ""),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/text-normalization", () => ({
	unescapeHtmlEntities: vi.fn((content: string) => content),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	everyLineHasLineNumbers: vi.fn().mockReturnValue(false),
	stripLineNumbers: vi.fn((content: string) => content),
}))

vi.mock("../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((message: string) => "Error: " + message),
		rooIgnoreError: vi.fn((filePath: string) => "Access denied: " + filePath),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../diff/stats", () => ({
	convertNewFileToUnifiedDiff: vi.fn((_content: string, relPath: string) => "diff for " + relPath),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
}))

vi.mock("../../shared/experiments", () => ({
	EXPERIMENT_IDS: { PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption" },
	experiments: {
		isEnabled: vi.fn((config: Record<string, boolean>, id: string) => config[id] === true),
	},
}))

// The seam under test is the identity this tool hands to guardedWrite, so the module entry is
// doubled rather than the filesystem: the canonical name is a sentinel no defaulted argument
// could produce by accident.
vi.mock("../guardedWrite", () => ({
	canonicalizeForApproval: vi.fn(async () => CANONICAL_TARGET),
}))

const CWD = "/workspace"
const REL_PATH = "src/index.ts"
const ABSOLUTE_PATH = path.resolve(CWD, REL_PATH)
const CANONICAL_TARGET = "/canonical/src/index.ts"
const NEW_CONTENT = "new line\n"
const OLD_CONTENT = "old line\n"
const SAVED = { newProblemsMessage: undefined, userEdits: undefined, finalContent: NEW_CONTENT }

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
const MOVED_STATS = {
	dev: 1n,
	ino: 2n,
	size: 9n,
	mtimeNs: 12n,
	ctimeNs: 11n,
	isSymbolicLink: () => false,
} as unknown as BigIntStats

// Computed with the real formatter so the token the spec asserts is the token the code derives
// from the same stat record, not a literal that happens to match.
const READ_TOKEN = versionTokenOfStat(READ_STATS)

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

function createHarness(preventFocusDisruption: boolean, fileExists: boolean, eventLog: string[]) {
	vi.mocked(fileExistsAtPath).mockResolvedValue(fileExists)

	// The canonical identity is captured by the tool, not by this spec, so the log entry is written by
	// the doubled module entry the tool calls: an absent or misordered capture fails the test rather
	// than being asserted after the fact from a value the spec itself supplied.
	vi.mocked(canonicalizeForApproval).mockImplementation(async () => {
		eventLog.push("canonical")
		return CANONICAL_TARGET
	})

	const saveChanges = vi.fn<SaveChangesDouble>().mockImplementation(async () => {
		eventLog.push("publish")
		return SAVED
	})
	const saveDirectly = vi.fn<SaveDirectlyDouble>().mockImplementation(async () => {
		eventLog.push("publish")
		return SAVED
	})
	const observe = vi.fn<(absolutePath: string, version: string, complete: boolean) => void>()

	const toolTask = {
		cwd: CWD,
		consecutiveMistakeCount: 0,
		didEditFile: false,
		api: { getModel: () => ({ id: "claude-test" }) },
		rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
		rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		observationRegistry: {
			get: vi
				.fn<(absolutePath: string) => { version: string; complete: boolean } | undefined>()
				.mockReturnValue(undefined),
			observe,
			has: vi.fn<(absolutePath: string) => boolean>().mockReturnValue(false),
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
		diffViewProvider: {
			editType: undefined as "create" | "modify" | undefined,
			isEditing: false,
			originalContent: "",
			open: vi.fn<(relPath: string) => Promise<void>>().mockResolvedValue(undefined),
			update: vi.fn<(content: string, streaming: boolean) => Promise<void>>().mockResolvedValue(undefined),
			reset: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			revertChanges: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn<(lineCount?: number, showDiff?: boolean) => void>(),
			updateDiagnosticSettings: vi.fn<(enabled: boolean) => void>(),
			saveChanges,
			saveDirectly,
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
	// A typed Task would require stubbing every member the class owns; this double carries only what
	// WriteToFileTool.execute reads, so the cast stays at the boundary with the mocks exposed.
	const task = toolTask as unknown as Task

	return { task, saveChanges, saveDirectly, observe }
}

async function runHandle(task: Task, eventLog: string[]) {
	const askApproval = vi.fn<ToolCallbacks["askApproval"]>().mockImplementation(async () => {
		eventLog.push("ask")
		return true
	})
	const block = {
		type: "tool_use",
		name: "write_to_file",
		params: { path: REL_PATH, content: NEW_CONTENT },
		// BaseTool.handle takes its parameters from nativeArgs only; params alone is the retired XML path and
		// would be refused before execute ran.
		nativeArgs: { path: REL_PATH, content: NEW_CONTENT },
		partial: false,
	} satisfies ToolUse<"write_to_file">

	await writeToFileTool.handle(task, block, {
		askApproval,
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
		toolCallId: "tool-call-1",
	} satisfies ToolCallbacks)
}

describe("WriteToFileTool guarded publish", () => {
	let eventLog: string[]

	beforeEach(() => {
		vi.clearAllMocks()
		eventLog = []
		writeToFileTool.resetPartialState()
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
		fsDouble.readFile.mockResolvedValue(OLD_CONTENT)
		fsDouble.stat.mockResolvedValue(READ_STATS)
	})

	describe("prevent-focus arm - full-file replacement published through saveDirectly", () => {
		it("names the update guard for an existing target instead of inheriting the create default", async () => {
			const { task, saveDirectly, saveChanges } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			// Sixth argument is the guarded-write kind. The shipped call stopped at five arguments, so
			// the guard judged a full-file replacement against the create default the signature carries.
			// Third argument is the open-the-editor-after-save flag this arm passes; naming it here keeps the
			// call the guard reads pinned argument by argument rather than only at the new arguments.
			expect(saveDirectly.mock.calls[0][2]).toBe(false)
			expect(saveDirectly.mock.calls[0][5]).toBe("update")
			// Seventh is completeOverride, which this arm earns through the observation it records
			// below; leaving it undefined is what lets the guard compare against that observation.
			expect(saveDirectly.mock.calls[0][6]).toBeUndefined()
			expect(saveChanges).not.toHaveBeenCalled()
		})

		it("names the create guard for an absent target and records no observation for it", async () => {
			const { task, saveDirectly, observe } = createHarness(true, false, eventLog)
			await runHandle(task, eventLog)
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			expect(saveDirectly.mock.calls[0][5]).toBe("create")
			expect(observe).not.toHaveBeenCalled()
			expect(fsDouble.readFile).not.toHaveBeenCalledWith(ABSOLUTE_PATH, "utf-8")
		})

		it("records its own whole-file read as a complete observation so the save compares against it", async () => {
			const { task, observe } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			// This arm holds the entire previous content. Without a record here guardedWrite finds obs
			// undefined and refuses a target this arm read end to end, which is the refusal that turned
			// a recorded host scenario into a fixture mismatch instead of a tool result.
			expect(observe).toHaveBeenCalledWith(ABSOLUTE_PATH, READ_TOKEN, true)
			expect(fsDouble.stat).toHaveBeenCalledTimes(2)
			// Both calls, not merely one of them: the bracket is two reads of the same version, and an
			// option object that reaches only the first of them is not a bracket.
			expect(fsDouble.stat.mock.calls.map((call) => call[1])).toEqual([{ bigint: true }, { bigint: true }])
			expect(fsDouble.readFile).toHaveBeenCalledWith(ABSOLUTE_PATH, "utf-8")
		})

		it("withholds the observation when the bracketing stats disagree", async () => {
			fsDouble.stat.mockReset()
			fsDouble.stat.mockResolvedValueOnce(READ_STATS).mockResolvedValueOnce(MOVED_STATS)
			const { task, observe } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			expect(fsDouble.stat).toHaveBeenCalledTimes(2)
			// A read that spans a version change is not evidence about one version, so it earns no
			// compare-and-swap token; the content still reaches the diff, only the vouching is withheld.
			expect(observe).not.toHaveBeenCalled()
			expect(task.diffViewProvider.originalContent).toBe(OLD_CONTENT)
		})

		it("records no observation and no base content when the bracketing stat cannot be taken", async () => {
			fsDouble.stat.mockReset()
			fsDouble.stat.mockRejectedValue(new Error("ENOENT: no such file or directory, stat"))
			const { task, observe, saveDirectly } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			// The bracket is what makes this read evidence about one version. When it cannot be taken the
			// arm still publishes the replacement it was handed, but it vouches for nothing and starts from
			// an empty base rather than from content it failed to read under a single version.
			expect(fsDouble.stat).toHaveBeenCalledTimes(2)
			expect(observe).not.toHaveBeenCalled()
			expect(fsDouble.readFile).not.toHaveBeenCalled()
			expect(task.diffViewProvider.originalContent).toBe("")
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			expect(saveDirectly.mock.calls[0][5]).toBe("update")
		})

		it("withholds the observation when the second bracketing stat finds the file gone", async () => {
			fsDouble.stat.mockReset()
			fsDouble.stat
				.mockResolvedValueOnce(READ_STATS)
				.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat"))
			const { task, observe, saveDirectly } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			// The file moved out from under the read between the read and the re-stat, so no single version
			// is vouched for. The replacement still publishes as an update against the content the read did
			// return, because that content is what the full-file replacement was built on.
			expect(fsDouble.stat).toHaveBeenCalledTimes(2)
			expect(observe).not.toHaveBeenCalledWith(ABSOLUTE_PATH, READ_TOKEN, true)
			expect(observe).not.toHaveBeenCalled()
			expect(task.diffViewProvider.originalContent).toBe(OLD_CONTENT)
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			expect(saveDirectly.mock.calls[0][5]).toBe("update")
		})

		it("records no observation when the file appears between the two bracketing stats", async () => {
			fsDouble.stat.mockReset()
			fsDouble.stat
				.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat"))
				.mockResolvedValueOnce(READ_STATS)
			const { task, observe, saveDirectly } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			// Nothing was read: the first stat failed, so there is no version token for the post-read stat
			// to be compared against, and a post-read stat that succeeds on its own is no evidence that the
			// content sitting in the diff belongs to the version that stat measures.
			expect(fsDouble.stat).toHaveBeenCalledTimes(2)
			expect(fsDouble.readFile).not.toHaveBeenCalled()
			expect(observe).not.toHaveBeenCalled()
			expect(task.diffViewProvider.originalContent).toBe("")
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			expect(saveDirectly.mock.calls[0][5]).toBe("update")
		})

		it("binds an approved outside-workspace target before the ask and threads it to the save", async () => {
			vi.mocked(isPathOutsideWorkspace).mockReturnValue(true)
			const { task, saveDirectly } = createHarness(true, true, eventLog)
			await runHandle(task, eventLog)
			expect(saveDirectly).toHaveBeenCalledTimes(1)
			// The reviewer approves a name; the publish acts on a resolved target. Capturing the
			// canonical identity after the ask would let a rename between the ask and the publish
			// retarget the write.
			expect(eventLog).toEqual(["canonical", "ask", "publish"])
			expect(saveDirectly.mock.calls[0][7]).toBe(true)
			expect(saveDirectly.mock.calls[0][8]).toBe(CANONICAL_TARGET)
		})
	})

	describe("diff-view arm - preview published through saveChanges", () => {
		it("names the update guard for an existing target instead of leaving it to the signature default", async () => {
			const { task, saveChanges, saveDirectly } = createHarness(false, true, eventLog)
			await runHandle(task, eventLog)
			expect(saveChanges).toHaveBeenCalledTimes(1)
			expect(saveChanges.mock.calls[0][0]).toBe(false)
			expect(saveChanges.mock.calls[0][1]).toBe(0)
			expect(saveChanges.mock.calls[0][2]).toBe("update")
			expect(saveDirectly).not.toHaveBeenCalled()
		})

		it("names the create guard for an absent target", async () => {
			const { task, saveChanges } = createHarness(false, false, eventLog)
			await runHandle(task, eventLog)
			expect(saveChanges).toHaveBeenCalledTimes(1)
			expect(saveChanges.mock.calls[0][2]).toBe("create")
		})

		it("threads the approved outside-workspace identity it computed before the ask", async () => {
			vi.mocked(isPathOutsideWorkspace).mockReturnValue(true)
			const { task, saveChanges } = createHarness(false, true, eventLog)
			await runHandle(task, eventLog)
			expect(saveChanges).toHaveBeenCalledTimes(1)
			expect(eventLog).toEqual(["canonical", "ask", "publish"])
			expect(saveChanges.mock.calls[0][3]).toBe(true)
			expect(saveChanges.mock.calls[0][4]).toBe(CANONICAL_TARGET)
		})
	})

	describe("in-workspace publishes", () => {
		it("asks no canonical identity and passes no approved target", async () => {
			const { task, saveChanges, saveDirectly } = createHarness(false, true, eventLog)
			await runHandle(task, eventLog)
			expect(canonicalizeForApproval).not.toHaveBeenCalled()
			expect(eventLog).toEqual(["ask", "publish"])
			expect(saveChanges.mock.calls[0][4]).toBeUndefined()
			expect(saveDirectly).not.toHaveBeenCalled()
		})
	})
})
