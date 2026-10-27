import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import type { Task } from "../../task/Task"
import { ApplyPatchTool } from "../ApplyPatchTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("original file content\n"),
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn((_cwd: string, p: string) => p),
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

type Experiments = Record<string, boolean>

interface ProviderFixture {
	getState: () => Promise<{ experiments?: Experiments }>
}

interface DiffViewFixture {
	editType: string | undefined
	originalContent: string | undefined
	open: (path: string) => Promise<void>
	update: (content: string, final: boolean) => Promise<void>
	reset: () => Promise<void>
	revertChanges: () => Promise<void>
	saveChanges: (diagnosticsEnabled?: boolean, writeDelayMs?: number) => Promise<void>
	saveDirectly: (
		path: string,
		content: string,
		open?: boolean,
		diagnosticsEnabled?: boolean,
		writeDelayMs?: number,
	) => Promise<void>
	scrollToFirstDiff: () => void
	pushToolWriteResult: () => Promise<string>
}

interface TaskFixture {
	cwd: string
	consecutiveMistakeCount: number
	didEditFile: boolean
	rooIgnoreController: { validateAccess: (path: string) => boolean }
	rooProtectedController: { isWriteProtected: (path: string) => boolean }
	providerRef: { deref: () => ProviderFixture | undefined }
	diffViewProvider: DiffViewFixture
	fileContextTracker: { trackFileContext: (path: string, source: string) => Promise<void> }
	say: (type: string, text?: string) => Promise<void>
	recordToolError: (tool: string, error?: string) => void
	recordToolUsage: (tool: string) => void
	processQueuedMessages: () => void
}

describe("ApplyPatchTool focus-disruption routing (L2)", () => {
	const addPatch = `*** Begin Patch
*** Add File: src/new.ts
+line one
*** End Patch`

	const updatePatch = `*** Begin Patch
*** Update File: src/existing.ts
@@
-original file content
+updated file content
*** End Patch`

	let fixture: TaskFixture
	let tool: ApplyPatchTool
	let approved: boolean

	beforeEach(() => {
		vi.clearAllMocks()
		approved = true
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)

		fixture = {
			cwd: "/workspace/project",
			consecutiveMistakeCount: 0,
			didEditFile: false,
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
			providerRef: { deref: vi.fn() },
			diffViewProvider: {
				editType: undefined,
				originalContent: undefined,
				open: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				revertChanges: vi.fn().mockResolvedValue(undefined),
				saveChanges: vi.fn().mockResolvedValue(undefined),
				saveDirectly: vi.fn().mockResolvedValue(undefined),
				scrollToFirstDiff: vi.fn(),
				pushToolWriteResult: vi.fn().mockResolvedValue("Changes successfully applied."),
			},
			fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
			say: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			processQueuedMessages: vi.fn(),
		}
		tool = new ApplyPatchTool()
	})

	const createProvider = (experiments: Experiments): ProviderFixture => ({
		getState: vi.fn().mockResolvedValue({ experiments }),
	})

	function setExperiments(experiments: Experiments) {
		fixture.providerRef.deref = vi.fn().mockReturnValue(createProvider(experiments))
	}

	async function runPatch(patch: string) {
		const pushToolResult = vi.fn()
		const handleError = vi.fn().mockResolvedValue(undefined)
		await tool.execute({ patch }, fixture as unknown as Task, {
			askApproval: vi.fn().mockImplementation(async () => approved),
			handleError,
			pushToolResult,
			toolCallId: "tool-call-1",
		})
		return { pushToolResult, handleError }
	}

	it("adds a file through the direct save when no experiment value is stored", async () => {
		setExperiments({})
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		const { pushToolResult, handleError } = await runPatch(addPatch)

		expect(fixture.diffViewProvider.saveDirectly).toHaveBeenCalledWith("src/new.ts", "line one\n", true, true, 0)
		expect(fixture.diffViewProvider.open).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(fixture.didEditFile).toBe(true)
		expect(pushToolResult).toHaveBeenCalledWith("Changes successfully applied.")
		expect(handleError).not.toHaveBeenCalled()
	})

	it("adds a file through the diff editor when the user opted out", async () => {
		setExperiments({ preventFocusDisruption: false })
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		const { pushToolResult, handleError } = await runPatch(addPatch)

		expect(fixture.diffViewProvider.open).toHaveBeenCalledWith("src/new.ts")
		expect(fixture.diffViewProvider.update).toHaveBeenCalledWith("line one\n", true)
		expect(fixture.diffViewProvider.saveChanges).toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Changes successfully applied.")
		expect(handleError).not.toHaveBeenCalled()
	})

	it("updates a file through the direct save when no experiment value is stored", async () => {
		setExperiments({})
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		const { pushToolResult, handleError } = await runPatch(updatePatch)

		expect(fixture.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
			"src/existing.ts",
			"updated file content\n",
			false,
			true,
			0,
		)
		expect(fixture.diffViewProvider.open).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(fixture.didEditFile).toBe(true)
	})

	it("updates a file through the diff editor when the user opted out", async () => {
		setExperiments({ preventFocusDisruption: false })
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		const { pushToolResult, handleError } = await runPatch(updatePatch)

		expect(fixture.diffViewProvider.open).toHaveBeenCalledWith("src/existing.ts")
		expect(fixture.diffViewProvider.update).toHaveBeenCalledWith("updated file content\n", true)
		expect(fixture.diffViewProvider.saveChanges).toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Changes successfully applied.")
		expect(handleError).not.toHaveBeenCalled()
	})

	it("rejects an add-file patch without saving when the experiment is unset", async () => {
		approved = false
		setExperiments({})
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		const { pushToolResult } = await runPatch(addPatch)

		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.open).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
	})

	it("reverts the diff editor and does not save a rejected add-file patch when opted out", async () => {
		approved = false
		setExperiments({ preventFocusDisruption: false })
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		await runPatch(addPatch)

		expect(fixture.diffViewProvider.open).toHaveBeenCalled()
		expect(fixture.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
	})

	it("rejects an update-file patch without saving when the experiment is unset", async () => {
		approved = false
		setExperiments({})
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		const { pushToolResult } = await runPatch(updatePatch)

		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.open).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
	})

	it("reverts the diff editor and does not save a rejected update-file patch when opted out", async () => {
		approved = false
		setExperiments({ preventFocusDisruption: false })
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)

		await runPatch(updatePatch)

		expect(fixture.diffViewProvider.open).toHaveBeenCalled()
		expect(fixture.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(fixture.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
	})
})
