// npx vitest run core/tools/__tests__/applyDiffTool.writeKind.spec.ts

import fs from "fs/promises"
import path from "path"
import type { BigIntStats } from "fs"

import type { Task } from "../../task/Task"
import { versionTokenOfStat } from "../../../utils/versionToken"
import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import type { ToolCallbacks } from "../BaseTool"
import { applyDiffTool } from "../ApplyDiffTool"

// The version token the guarded publish consumes comes from the bigint stats that bracket the
// tool's own read. BigIntStats is a class-backed interface without a public constructor, so a
// plain-object double is the only way to pin that token without real files; single-step
// downcast from Partial to the full type (test-local, per AGENTS.md). Every call returns a
// fresh object so one case cannot leak a mutated stat into the next.
const { readStats, statDouble, armStatDrift } = vi.hoisted(() => {
	const base: Partial<BigIntStats> = {
		dev: 7n,
		ino: 4242n,
		size: 1234n,
		atimeMs: 1_700_000_000_000n,
		mtimeMs: 1_700_000_000_123n,
		ctimeMs: 1_700_000_000_789n,
		birthtimeMs: 1_700_000_000_000n,
		atimeNs: 1_700_000_000_000_000_000n,
		mtimeNs: 1_700_000_000_123_456_789n,
		ctimeNs: 1_700_000_000_789_999_999n,
		birthtimeNs: 1_700_000_000_000_000_000n,
	}
	const state = { calls: 0, drift: false }
	return {
		readStats: (overrides: Partial<BigIntStats> = {}): BigIntStats => ({ ...base, ...overrides }) as BigIntStats,
		// Arming the drift makes the SECOND of the two bracketing stats disagree, which is the
		// S2 condition under which the read records nothing.
		statDouble: (): BigIntStats => {
			const drifted = state.drift && state.calls > 0
			state.calls += 1
			return (drifted ? { ...base, mtimeNs: 1_700_000_000_123_456_790n } : { ...base }) as BigIntStats
		},
		armStatDrift: (drift: boolean): void => {
			state.drift = drift
			state.calls = 0
		},
	}
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("old\n"),
		stat: vi.fn().mockImplementation(async () => statDouble()),
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

vi.mock("vscode", () => ({
	window: { showWarningMessage: vi.fn() },
	env: { openExternal: vi.fn() },
	Uri: { parse: vi.fn() },
	workspace: {
		get workspaceFolders() {
			return [{ uri: { fsPath: path.resolve(CWD) } }]
		},
	},
}))

const CWD = "/workspace"
const REL_PATH = "src/index.ts"
const ABSOLUTE_PATH = path.resolve(CWD, REL_PATH)
const DIFF = "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"
const READ_TOKEN = versionTokenOfStat(readStats())

// The two saves and the observation registry are shared spies, so each case asserts on the one
// publish the flow performs; a fresh double per task would let a second, differently-kinded
// publish slip past an assertion that only ever inspected the first.
const saveChanges = vi.fn().mockResolvedValue(undefined)
const saveDirectly = vi.fn().mockResolvedValue(undefined)
const registryGet = vi.fn().mockReturnValue(undefined)
const registryObserve = vi.fn()
const registryHas = vi.fn().mockReturnValue(false)
const askApproval = vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true)

function createTask(preventFocusDisruption = false): Task {
	const task = {
		cwd: CWD,
		consecutiveMistakeCount: 0,
		consecutiveMistakeCountForApplyDiff: new Map<string, number>(),
		didEditFile: false,
		api: { getModel: () => ({ id: "claude-test" }) },
		rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
		rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
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
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges,
			saveDirectly,
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi
				.fn()
				.mockResolvedValue('{"path":"src/index.ts","operation":"modified","notice":"baseline"}'),
		},
		observationRegistry: {
			get: registryGet,
			has: registryHas,
			observe: registryObserve,
			forget: vi.fn(),
		},
		fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue(undefined),
		recordToolError: vi.fn(),
		processQueuedMessages: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
	}
	// The double provides only the Task members that ApplyDiffTool.execute reads.
	return task as unknown as Task
}

async function runExecute(preventFocusDisruption = false): Promise<void> {
	await applyDiffTool.execute({ path: REL_PATH, diff: DIFF }, createTask(preventFocusDisruption), {
		askApproval,
		handleError: vi.fn().mockResolvedValue(undefined),
		pushToolResult: vi.fn(),
		toolCallId: "tool-call-write-kind",
	})
}

// The mocked-provider suite replays an apply_diff turn that is matched on a tool result of
// {"path":...,"operation":"modified"}. While the diff-view save ran on its "update" default the
// guard read the accepted preview as a full-file replacement, refused it behind the partial-read
// remediation, and the tool result the provider was promised never existed. The write kind the
// tool asks for, and the observation its own read records to authorize that kind, are the
// contract these cases pin.
//
// The expectation spells the whole argument list the publish now carries: the third argument is
// the write kind and the fourth and fifth are the outside-workspace approval flag and the identity
// that approval was granted to, which is the shape applyPatchTool.execute.spec.ts:745 pins for the
// tool this one mirrors.
describe("ApplyDiffTool write kind", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		applyDiffTool.resetPartialState()
		armStatDrift(false)
		registryGet.mockReturnValue(undefined)
		registryHas.mockReturnValue(false)
		registryObserve.mockImplementation(() => undefined)
		saveChanges.mockResolvedValue(undefined)
		saveDirectly.mockResolvedValue(undefined)
		askApproval.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("old\n")
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
	})

	it("publishes the accepted hunk through the diff-view save as an edit", async () => {
		await runExecute()

		expect(saveChanges).toHaveBeenCalledTimes(1)
		expect(saveChanges).toHaveBeenCalledWith(false, 0, "edit", false, undefined)
		expect(saveDirectly).not.toHaveBeenCalled()
	})

	it("publishes the accepted hunk through the guarded direct save as an edit", async () => {
		await runExecute(true)

		expect(saveDirectly).toHaveBeenCalledTimes(1)
		expect(saveDirectly).toHaveBeenCalledWith(
			REL_PATH,
			"new\n",
			false,
			false,
			0,
			"edit",
			undefined,
			false,
			undefined,
		)
		expect(saveChanges).not.toHaveBeenCalled()
	})

	it("records its own read as an incomplete observation so the edit guard accepts the publish", async () => {
		await runExecute()

		expect(registryObserve).toHaveBeenCalledTimes(1)
		expect(registryObserve).toHaveBeenCalledWith(ABSOLUTE_PATH, READ_TOKEN, false)
	})

	it("keeps a matching complete read complete rather than downgrading it to the hunk", async () => {
		registryGet.mockReturnValue({ version: READ_TOKEN, complete: true })

		await runExecute()

		expect(registryObserve).toHaveBeenCalledTimes(1)
		expect(registryObserve).toHaveBeenCalledWith(ABSOLUTE_PATH, READ_TOKEN, true)
	})

	it("leaves an observation of an older version exactly as the model earned it", async () => {
		registryGet.mockReturnValue({ version: "9:9:9:9:9", complete: true })

		await runExecute()

		expect(registryObserve).not.toHaveBeenCalled()
		expect(saveChanges).toHaveBeenCalledWith(false, 0, "edit", false, undefined)
	})

	it("records nothing when the read is not stat-matched, leaving the publish unobserved", async () => {
		armStatDrift(true)

		await runExecute()

		expect(registryObserve).not.toHaveBeenCalled()
		expect(saveChanges).toHaveBeenCalledWith(false, 0, "edit", false, undefined)
	})
})
