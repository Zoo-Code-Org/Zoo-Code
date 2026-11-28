// npx vitest run core/task/__tests__/background-ask-policy.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { type ExtensionState, RooCodeEventName } from "@roo-code/types"

import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"
import { isRealPathOutsideWorkspace } from "../../../utils/pathUtils"

// The streaming-loop drive below never asserts on environment details; the
// real collector reaches into the VS Code window API, which this file's
// lightweight task stub does not model.
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

// M-1: the read carve-out consults the canonical outside-workspace gate
// (isRealPathOutsideWorkspace), which reads vscode.workspace.workspaceFolders
// and the real filesystem. Mock it so the seam tests can pin both the
// in-workspace (approve) and outside-workspace (deny) decisions
// deterministically; the real-filesystem regression block below reinstalls the
// production implementation.
vi.mock("../../../utils/pathUtils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/pathUtils")>()
	return {
		...actual,
		isRealPathOutsideWorkspace: vi.fn(),
	}
})

// D4 ask policy: a background (read-only) child task must never post a chat
// row and wait for a user click. When the auto-approval decision is `ask`,
// ask() resolves deterministically by ask type. Read-only tool asks resolve
// approved (D4 scopes the auto-deny to non-read tools: the user already
// approved the parallel_subtasks call, and the child's structural tool policy
// blocks every dangerous tool); every other tool ask carries the structured
// `background_policy` auto-deny detail; every non-tool ask type resolves to
// `noButtonClicked` without any detail. An ask whose tool text is not
// say-tool JSON fails closed to the auto-deny.

/** The parts of the provider that `Task.ask` reaches for. */
type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	postStateToWebviewWithoutTaskHistory: ReturnType<typeof vi.fn>
	getSkillsManager: () => undefined
	cwd: string
}

const TASK_CWD = "/path/to/task-workspace"

function buildTask(provider: ProviderStub, taskCwd: string, isBackgroundChild: boolean) {
	const task = Object.create(Task.prototype) as Task
	setAbortLatch(task, false)
	task["clineMessages"] = []
	task["askResponse"] = undefined
	task["askResponseText"] = undefined
	task["askResponseImages"] = undefined
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => {})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
	task["checkpointSave"] = vi.fn(async () => {})
	task["emit"] = vi.fn()
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`,
	// and the stub is neither a `WeakRef` nor a whole `ClineProvider`. Constructing
	// either would drag in the extension host, when `Task.ask` only ever calls
	// `deref()`, `getState()` and `postMessageToWebview()` on it.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: taskCwd })
	Object.defineProperty(task, "isBackgroundSubtaskChild", { value: isBackgroundChild })
	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	const queue = new MessageQueueService()
	Object.defineProperty(task, "messageQueueService", { value: queue })
	return queue
}

describe("Task.ask fail-closed policy for background children (D4)", () => {
	let state: Partial<ExtensionState>
	let provider: ProviderStub

	beforeEach(() => {
		// Auto-approval off: checkAutoApproval resolves every blocking ask type
		// with the `ask` decision, which is exactly the seam D4 intercepts.
		state = { autoApprovalEnabled: false }
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: TASK_CWD,
			getState: async () => state,
		}
		// M-1 default: the read target resolves inside the workspace, so the
		// carve-out approves it. Outside-workspace cases override per test.
		vi.mocked(isRealPathOutsideWorkspace).mockReset()
		vi.mocked(isRealPathOutsideWorkspace).mockResolvedValue(false)
	})

	it("resolves a non-read tool ask without a user click and carries the background_policy detail", async () => {
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("background_policy")
		// The presenter's structured auto-deny path is armed, mirroring the deny
		// branch of a policy denial.
		expect(task["pendingAutoDenyDetail"]).toEqual({ kind: "background_policy" })
		// Fail closed before any chat row exists: no approval prompt was posted.
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(task["emit"]).not.toHaveBeenCalledWith(RooCodeEventName.TaskInteractive, expect.anything())
	})

	it.each(["readFile", "listFiles", "listFilesTopLevel", "listFilesRecursive", "searchFiles", "codebaseSearch"])(
		"approves a %s tool ask under default settings (no alwaysAllowReadOnly)",
		async (tool) => {
			// Default settings: autoApprovalEnabled false, no alwaysAllowReadOnly,
			// no allowedReadFiles — checkAutoApproval returns `ask` for every
			// read. The D4 read carve-out must still resolve the ask approved;
			// this is the regression test for the blanket-deny P0. The gate is
			// mocked to in-workspace (the default set in beforeEach).
			const task = buildTask(provider, TASK_CWD, true)
			await attachQueue(task)

			const result = await task.ask("tool", JSON.stringify({ tool, path: "a.txt" }), false)

			expect(result.response).toBe("yesButtonClicked")
			expect(result.autoDenyDetail).toBeUndefined()
			expect(task["pendingAutoDenyDetail"]).toBeUndefined()
			// Approved without any chat row: the child never prompts.
			expect(task["addToClineMessages"]).not.toHaveBeenCalled()
			expect(task["emit"]).not.toHaveBeenCalledWith(RooCodeEventName.TaskInteractive, expect.anything())
		},
	)

	it("M-1: approves an in-workspace read under default settings", async () => {
		vi.mocked(isRealPathOutsideWorkspace).mockResolvedValue(false)
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "src/a.txt" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		// The gate was consulted with the path resolved against the task cwd.
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledWith(expect.stringContaining("a.txt"))
	})

	it("M-1: denies an outside-workspace read under default settings (fail closed)", async () => {
		// A prompt-injected child must not be able to read e.g. ~/.ssh/id_rsa
		// through the read carve-out.
		vi.mocked(isRealPathOutsideWorkspace).mockResolvedValue(true)
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "../../.ssh/id_rsa" }), false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("background_policy")
		expect(task["pendingAutoDenyDetail"]).toEqual({ kind: "background_policy" })
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
	})

	it("M-1: approves a batch read when every batch target is in the workspace", async () => {
		// ReadFileTool's batch approval ask carries no top-level `path`: every
		// target lives in `batchFiles`. Each one must go through the gate.
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask(
			"tool",
			JSON.stringify({
				tool: "readFile",
				batchFiles: [
					{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" },
					{ path: "src/b.ts", lineSnippet: "", key: "src/b.ts" },
				],
			}),
			false,
		)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		// The gate ran on EVERY batch target, resolved against the task cwd
		// exactly like the single-path case.
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledTimes(2)
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(TASK_CWD, "src/a.txt"))
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(TASK_CWD, "src/b.ts"))
	})

	it("M-1: denies a batch read when any batch target is outside the workspace (fail closed)", async () => {
		// One outside entry must deny the WHOLE batch: the outside file's
		// contents would land in the workspace report either way.
		vi.mocked(isRealPathOutsideWorkspace).mockImplementation(async (candidate) => candidate.includes("id_rsa"))
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask(
			"tool",
			JSON.stringify({
				tool: "readFile",
				batchFiles: [
					{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" },
					{ path: "../../.ssh/id_rsa", lineSnippet: "", key: "../../.ssh/id_rsa" },
				],
			}),
			false,
		)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("background_policy")
		expect(task["pendingAutoDenyDetail"]).toEqual({ kind: "background_policy" })
		// The gate still checked every entry, including the in-workspace one.
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(TASK_CWD, "src/a.txt"))
		expect(isRealPathOutsideWorkspace).toHaveBeenCalledWith(path.resolve(TASK_CWD, "../../.ssh/id_rsa"))
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
	})

	it.each([
		["an entry with an empty path", [{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" }, { path: "" }]],
		[
			"an entry with a missing path",
			[
				{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" },
				{ lineSnippet: "", key: "b" },
			],
		],
		["an entry with a non-string path", [{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" }, { path: 42 }]],
		["a null entry", [null]],
		["a non-array batchFiles", "not-an-array"],
	] as Array<[string, unknown]>)(
		"M-1: fails closed on a batch read with %s — the unverifiable entry must not ride an approved batch",
		async (_label, batchFiles) => {
			vi.mocked(isRealPathOutsideWorkspace).mockClear()
			const task = buildTask(provider, TASK_CWD, true)
			await attachQueue(task)

			const result = await task.ask("tool", JSON.stringify({ tool: "readFile", batchFiles }), false)

			expect(result.response).toBe("noButtonClicked")
			expect(result.autoDenyDetail?.kind).toBe("background_policy")
			// Unverifiable entries are never silently skipped: the gate never
			// saw the batch, so nothing in it can be approved.
			expect(isRealPathOutsideWorkspace).not.toHaveBeenCalled()
		},
	)

	it("M-1: a batch read with no entries stays approved without consulting the gate", async () => {
		vi.mocked(isRealPathOutsideWorkspace).mockClear()
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", batchFiles: [] }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		expect(isRealPathOutsideWorkspace).not.toHaveBeenCalled()
	})

	it("M-1: a read-only ask with no path field stays approved without consulting the gate", async () => {
		vi.mocked(isRealPathOutsideWorkspace).mockClear()
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "runSlashCommand" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		expect(isRealPathOutsideWorkspace).not.toHaveBeenCalled()
	})

	it.each(["not json at all", "{}", JSON.stringify({ path: "a.txt" }), '{"tool": 42}'])(
		"fails closed to the auto-deny when the tool ask text is %j",
		async (text) => {
			const task = buildTask(provider, TASK_CWD, true)
			await attachQueue(task)

			const result = await task.ask("tool", text, false)

			expect(result.response).toBe("noButtonClicked")
			expect(result.autoDenyDetail?.kind).toBe("background_policy")
		},
	)

	it.each(["followup", "api_req_failed", "command", "completion_result"] as const)(
		"resolves a %s ask without a user click and without a chat row",
		async (type) => {
			const task = buildTask(provider, TASK_CWD, true)
			await attachQueue(task)

			const result = await task.ask(type, "{}", false)

			expect(result.response).toBe("noButtonClicked")
			expect(result.autoDenyDetail).toBeUndefined()
			expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		},
	)

	it("releases a claimed queued message instead of stranding it", async () => {
		const task = buildTask(provider, TASK_CWD, true)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback arriving during a background child ask")

		const result = await task.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)

		expect(result.response).toBe("noButtonClicked")
		// The early return must not consume the message as fake approval nor
		// leave it claimed: it survives, unclaimed, for a later consumer.
		expect(result.queuedMessageId).toBeUndefined()
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("does not approve a read ask aborted while the M-1 gate lookup is pending", async () => {
		// axGv: the gate lookup is async, so a cancellation can land while it is
		// pending. The pre-resolution abort check runs before the lookup
		// starts; without a recheck after it, a late in-workspace result would
		// still return yesButtonClicked for an already-aborted task. The lookup
		// resolves late here; the ask must fail closed with the standard abort
		// error, and a queued message claimed for the ask must be released,
		// not stranded.
		let resolveGate!: (outside: boolean) => void
		vi.mocked(isRealPathOutsideWorkspace).mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolveGate = resolve
				}),
		)
		const task = buildTask(provider, TASK_CWD, true)
		const queue = await attachQueue(task)
		queue.addMessage("queued feedback arriving during the gate lookup")

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile", path: "a.txt" }), false)
		// The abort must land after the pre-resolution check and while the
		// lookup is suspended, so wait until the gate has been consulted.
		await vi.waitFor(() => expect(isRealPathOutsideWorkspace).toHaveBeenCalled())
		setAbortLatch(task, true)
		// The in-workspace verdict arrives only after the abort.
		resolveGate(false)

		await expect(askPromise).rejects.toMatchObject({
			name: "Error",
			message: `[RooCode#ask] task ${task.taskId}.${task.instanceId} aborted`,
		})
		// Fail closed: no approval, no chat row, and the claimed queued
		// message is released for a later consumer.
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(queue.messages).toHaveLength(1)
		expect(queue.hasUnclaimed()).toBe(true)
	})

	it("leaves the interactive flow untouched for a non-background task", async () => {
		const task = buildTask(provider, TASK_CWD, false)
		await attachQueue(task)
		const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>

		const askPromise = task.ask("tool", JSON.stringify({ tool: "write_to_file", path: "a.txt" }), false)
		// The ask posts its chat row and blocks, exactly as before D4.
		await vi.waitFor(() => expect(addToClineMessages).toHaveBeenCalledTimes(1))
		expect(addToClineMessages.mock.calls[0][0].type).toBe("ask")
		expect(addToClineMessages.mock.calls[0][0].ask).toBe("tool")

		task.approveAsk()
		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("leaves an auto-approved ask untouched for a background child", async () => {
		// With alwaysAllowReadOnly on, checkAutoApproval itself approves the read
		// (decision "approve"), so the D4 seam never engages. This test pins the
		// seam's no-op for auto-answered asks; the default-settings read path is
		// covered by the carve-out tests above.
		state = { autoApprovalEnabled: true, alwaysAllowReadOnly: true }
		const task = buildTask(provider, TASK_CWD, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "a.txt" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})
})

// CR-1 (CodeRabbit finding 1, Task.ts carve-out): the M-1 gate must compare
// CANONICAL paths. These tests run the production isRealPathOutsideWorkspace
// against a real temporary filesystem: a workspace symlink pointing outside
// must be denied even though its lexical path sits inside the workspace, and a
// real in-workspace file must stay approved under default settings.
describe("M-1 canonical gate against a real filesystem (CR-1)", () => {
	// Set up at collection time so it.runIf can branch on symlink support.
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zoo-cr1-m1-"))
	const workspaceDir = path.join(tempRoot, "workspace")
	const outsideDir = path.join(tempRoot, "outside")
	fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true })
	fs.mkdirSync(outsideDir)
	fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside secret")
	fs.writeFileSync(path.join(workspaceDir, "src", "a.txt"), "in-workspace file")
	// `private-link` is a workspace entry whose TARGET lives outside the
	// workspace — the escape the lexical gate missed. A junction is a directory
	// link creatable without elevation on Windows and a plain directory symlink
	// elsewhere.
	let symlinkCreated = false
	try {
		fs.symlinkSync(outsideDir, path.join(workspaceDir, "private-link"), "junction")
		symlinkCreated = true
	} catch {
		symlinkCreated = false
	}

	afterAll(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	})

	// The global vscode mock exposes workspaceFolders as a plain mutable
	// property; the double assertion stands in for the mock's lack of typed
	// mutability (the real API declares the property readonly).
	const setWorkspaceFolders = (folders: { uri: { fsPath: string } }[]) => {
		;(vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders = folders
	}

	let provider: ProviderStub

	beforeEach(async () => {
		provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: workspaceDir,
			getState: async () => ({ autoApprovalEnabled: false }),
		}
		// Reinstall the production gate and point the mocked vscode at the real
		// temp workspace.
		const actual = await vi.importActual<typeof import("../../../utils/pathUtils")>("../../../utils/pathUtils")
		vi.mocked(isRealPathOutsideWorkspace).mockReset()
		vi.mocked(isRealPathOutsideWorkspace).mockImplementation(actual.isRealPathOutsideWorkspace)
		setWorkspaceFolders([{ uri: { fsPath: workspaceDir } }])
	})

	afterEach(() => {
		setWorkspaceFolders([])
	})

	it.runIf(symlinkCreated)(
		"M-1: denies a read whose workspace symlink target escapes the workspace (real symlink, fail closed)",
		async () => {
			const task = buildTask(provider, workspaceDir, true)
			await attachQueue(task)

			const result = await task.ask(
				"tool",
				JSON.stringify({ tool: "readFile", path: "private-link/secret.txt" }),
				false,
			)

			expect(result.response).toBe("noButtonClicked")
			expect(result.autoDenyDetail?.kind).toBe("background_policy")
			expect(task["pendingAutoDenyDetail"]).toEqual({ kind: "background_policy" })
			// Denied before any chat row exists: the child never prompts.
			expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		},
	)

	it.runIf(symlinkCreated)(
		"M-1: denies a batch read when any batch target escapes through a workspace symlink (real gate, fail closed)",
		async () => {
			// The batch ask shape carries no top-level `path`, so the canonical
			// gate must run per `batchFiles` entry: the symlinked outside entry
			// denies the whole batch even alongside a real in-workspace file.
			const task = buildTask(provider, workspaceDir, true)
			await attachQueue(task)

			const result = await task.ask(
				"tool",
				JSON.stringify({
					tool: "readFile",
					batchFiles: [
						{ path: "src/a.txt", lineSnippet: "", key: "src/a.txt" },
						{ path: "private-link/secret.txt", lineSnippet: "", key: "private-link/secret.txt" },
					],
				}),
				false,
			)

			expect(result.response).toBe("noButtonClicked")
			expect(result.autoDenyDetail?.kind).toBe("background_policy")
			expect(task["pendingAutoDenyDetail"]).toEqual({ kind: "background_policy" })
		},
	)

	it("M-1: approves a real in-workspace read under default settings", async () => {
		const task = buildTask(provider, workspaceDir, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "src/a.txt" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("M-1: fails closed through the real gate when no workspace folder is configured", async () => {
		setWorkspaceFolders([])
		const task = buildTask(provider, workspaceDir, true)
		await attachQueue(task)

		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "src/a.txt" }), false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("background_policy")
	})
})
