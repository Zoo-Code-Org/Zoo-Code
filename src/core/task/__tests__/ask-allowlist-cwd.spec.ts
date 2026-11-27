// npx vitest run core/task/__tests__/ask-allowlist-cwd.spec.ts

import fs from "fs"
import os from "os"
import path from "path"

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"

// Doubles for the workspace. The shared vscode mock resolves every lookup
// to nothing, so a command ask could not name a folder.
const workspaceState = vi.hoisted(() => ({
	workspaceFolders: [] as { fsPath: string; uri: { fsPath: string } }[],
	foldersByPath: new Map<string, { fsPath: string }>(),
	configScripts: {} as Record<string, { gate?: boolean; allow?: string[]; deny?: string[] }>,
}))

vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return {
		...actual,
		workspace: {
			...actual.workspace,
			get workspaceFolders() {
				return workspaceState.workspaceFolders
			},
			getConfiguration: (_section?: string, scope?: { fsPath?: string } | null) => {
				const entry = workspaceState.configScripts[scope?.fsPath ?? ""]
				return {
					get: (key: string, defaultValue?: unknown) =>
						key === "workspaceCommandListsEnabled" ? (entry?.gate ?? false) : defaultValue,
					inspect: (key: string) => {
						const layer =
							key === "deniedCommands"
								? entry?.deny
								: key === "allowedCommands"
									? entry?.allow
									: undefined
						return layer ? { key, workspaceFolderValue: layer } : undefined
					},
					update: () => Promise.resolve(),
				}
			},
			getWorkspaceFolder: (resource?: { fsPath?: string }) => {
				const fsPath = resource?.fsPath ?? ""
				for (const [folderPath, uri] of workspaceState.foldersByPath) {
					if (fsPath === folderPath || fsPath.startsWith(`${folderPath}/`)) {
						return { uri }
					}
				}
				return undefined
			},
		},
	}
})

// The allowlist patterns are resolved against a workspace root, and the path in
// the tool message was made relative by `getReadablePath(task.cwd, ...)`. So the
// root used for matching has to be the task's own `cwd`.
//
// The provider's `cwd` is a different value: it follows the window (the focused
// editor under multi-root workspaces, or a `refreshWorkspace()` mid-task), while a
// task resumed from history or created as a child keeps the workspace it belongs
// to. When the two diverge, resolving against the provider's would let a pattern
// written for one workspace approve a write landing in another.

/** The parts of the provider that `Task.ask` reaches for. */
type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	cwd: string
}

function buildTask(provider: ProviderStub, taskCwd: string) {
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
	// `Task.cwd` reads `workspacePath`, which is `historyItem.workspace` for a
	// resumed task and the parent's path for a child one. It is `readonly`, so the
	// stub installs it the way the constructor would.
	Object.defineProperty(task, "workspacePath", { value: taskCwd })

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	Object.defineProperty(task, "messageQueueService", { value: new MessageQueueService() })
}

const TASK_CWD = "/path/to/task-workspace"
const PROVIDER_CWD = "/path/to/window-workspace"

const buildProvider = (allowedWriteFiles: string[]): ProviderStub => ({
	postMessageToWebview: vi.fn().mockResolvedValue(undefined),
	cwd: PROVIDER_CWD,
	getState: async () => ({
		autoApprovalEnabled: true,
		alwaysAllowWrite: false,
		alwaysAllowWriteProtected: false,
		allowedReadFiles: [],
		allowedWriteFiles,
	}),
})

/**
 * Ask to write a workspace-relative path and report whether it was auto-approved.
 *
 * An ask that is not auto-answered blocks until the user responds, so the outcome
 * is read from the message instead of the returned promise: `Task.ask` stamps
 * `autoApprovalDecision` on it when it resolves the ask itself. The ask is then
 * answered so nothing is left pending.
 */
const askToWriteRelativePath = async (allowedWriteFiles: string[]) => {
	const task = buildTask(buildProvider(allowedWriteFiles), TASK_CWD)
	await attachQueue(task)

	// A relative path, as `getReadablePath(task.cwd, relPath)` produces for a file
	// inside the task's own workspace.
	const asked = task.ask("tool", JSON.stringify({ tool: "newFileCreated", path: "notes.md" }), false)

	const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
	await vi.waitUntil(() => addToClineMessages.mock.calls.length > 0)
	const message = addToClineMessages.mock.calls[0][0]

	task.approveAsk()
	await asked

	return message.autoApprovalDecision ?? ("ask" as const)
}

describe("Task.ask resolves allowlists against the task's workspace", () => {
	it("approves a file the task's own workspace root makes match", async () => {
		expect(await askToWriteRelativePath([`${TASK_CWD}/notes.md`])).toBe("approve")
	})

	it("does not approve a pattern that only matches under the provider's workspace root", async () => {
		expect(await askToWriteRelativePath([`${PROVIDER_CWD}/notes.md`])).toBe("ask")
	})
})

// Command asks follow the command's own cwd (commandCwd), not the task
// folder, so folder A's allow entry cannot approve a command in folder B. The
// raw global layers are empty, so each decision comes from the command's
// folder. The baked pair holds values that no folder composes.
//
// A root the filesystem cannot resolve drops the folder layer: the resolver
// compares each root by its real path, so a fictional root would leave the
// global layers deciding alone. `beforeEach` creates the two roots on disk and
// `openTwoFolders()` registers them by that real path, so the registered and
// resolved spellings agree on case-insensitive filesystems. The test below for
// a folder that no longer resolves registers one folder by a spelling the
// filesystem cannot resolve, so the two disagree on purpose.

let fixtureRoot = ""
let FOLDER_A = ""
let FOLDER_B = ""

function createFolder(parent: string, name: string): string {
	const directory = path.join(parent, name)
	fs.mkdirSync(directory)
	return fs.realpathSync.native(directory)
}

function openTwoFolders() {
	const folderA = { fsPath: FOLDER_A, uri: { fsPath: FOLDER_A } }
	const folderB = { fsPath: FOLDER_B, uri: { fsPath: FOLDER_B } }
	workspaceState.workspaceFolders = [folderA, folderB]
	workspaceState.foldersByPath.set(FOLDER_A, folderA.uri)
	workspaceState.foldersByPath.set(FOLDER_B, folderB.uri)
	// Folder A allows "echo" and folder B denies it, so a decision names the folder read.
	workspaceState.configScripts = {
		[FOLDER_A]: { gate: true, allow: ["echo"] },
		[FOLDER_B]: { gate: true, deny: ["echo"] },
	}
}

const commandState = (extra: Partial<ExtensionState> = {}): Partial<ExtensionState> => ({
	autoApprovalEnabled: true,
	alwaysAllowExecute: true,
	allowedCommands: ["echo"],
	deniedCommands: [],
	globalAllowedCommands: [],
	globalDeniedCommands: [],
	...extra,
})

/** Ask to run a command with the given approval context and report the policy decision. */
const askToRunCommand = async (commandCwd: string | undefined, state: Partial<ExtensionState>) => {
	const provider: ProviderStub = {
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		cwd: PROVIDER_CWD,
		getState: async () => state,
	}
	// The task runs in folder A; its allow entry must not approve a command in folder B.
	const task = buildTask(provider, FOLDER_A)
	await attachQueue(task)

	const asked = task.ask("command", "echo hi", false, undefined, false, { commandCwd })

	const addToClineMessages = task["addToClineMessages"] as ReturnType<typeof vi.fn>
	await vi.waitUntil(() => addToClineMessages.mock.calls.length > 0)
	const message = addToClineMessages.mock.calls[0][0]

	task.approveAsk()
	await asked

	return message.autoApprovalDecision ?? ("ask" as const)
}

describe("Task.ask judges command asks by the command's working directory", () => {
	beforeEach(() => {
		workspaceState.workspaceFolders = []
		workspaceState.foldersByPath.clear()
		workspaceState.configScripts = {}
		fixtureRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ask-allowlist-cwd-")))
		FOLDER_A = createFolder(fixtureRoot, "folder-a")
		FOLDER_B = createFolder(fixtureRoot, "folder-b")
	})

	afterEach(() => {
		fs.rmSync(fixtureRoot, { recursive: true, force: true })
	})

	it("approves a command whose custom cwd resolves to the folder that allows it", async () => {
		openTwoFolders()
		// Only folder B carries the entry, so only the command's folder can approve.
		workspaceState.configScripts[FOLDER_A] = { gate: true }
		workspaceState.configScripts[FOLDER_B] = { gate: true, allow: ["echo"] }

		expect(await askToRunCommand(FOLDER_B, commandState())).toBe("approve")
	})

	it("does not approve a command executing where the same entry is denied, although the task folder allows it", async () => {
		openTwoFolders()

		// Folder A allows "echo" but the command runs in denying folder B: deny decides.
		expect(await askToRunCommand(FOLDER_B, commandState())).toBe("deny")
	})

	it("judges a custom cwd that names no workspace folder by the global layers only", async () => {
		openTwoFolders()

		// The baked pair would approve. Re-composition drops the workspace layer
		// for an unmatched cwd, so nothing matches and the user decides.
		expect(await askToRunCommand("/mock/removed-folder", commandState())).toBe("ask")
	})

	it("does not approve a command from a registered folder that no longer resolves on disk", async () => {
		// A folder that was moved or deleted keeps its registry entry. Its real
		// path is then unknown, so nothing confirms it holds the command's
		// directory. Matching the command against the registered spelling would
		// let a root that bounds nothing approve it, so the folder layer is
		// dropped and only the global layers decide.
		const removedFolder = path.join(fixtureRoot, "removed-folder")
		fs.mkdirSync(removedFolder)
		fs.rmSync(removedFolder, { recursive: true, force: true })
		const removedUri = { fsPath: removedFolder }
		workspaceState.workspaceFolders = [{ fsPath: removedFolder, uri: removedUri }]
		workspaceState.foldersByPath.set(removedFolder, removedUri)
		// The entry would approve the command if the registered spelling decided.
		workspaceState.configScripts = { [removedFolder]: { gate: true, allow: ["echo"] } }

		expect(await askToRunCommand(path.join(removedFolder, "sub"), commandState())).toBe("ask")
	})

	it("keeps judging a command without a custom cwd by the task folder's policy", async () => {
		openTwoFolders()

		// No approval context at all: the task folder's own entry still decides.
		expect(await askToRunCommand(undefined, commandState())).toBe("approve")
	})

	it("re-checks a drained queued command against the command's working directory", async () => {
		openTwoFolders()
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			// First read (ask time): blanket deny off, so the ask stays pending.
			// Second read (drain re-check): blanket deny engaged.
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysAllowExecute: false, alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		// The task is in denying folder B and the command runs in allowing folder A.
		// A fallback to the task folder would deny what folder A grants.
		const task = buildTask(provider, FOLDER_B)
		await attachQueue(task)

		const asked = task.ask("command", "echo hi", false, undefined, false, { commandCwd: FOLDER_A })
		await vi.waitUntil(() => (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls.length > 0)
		task.messageQueueService.addMessage("run it")

		// Folder A approves. Judging the defaults or the baked pair would deny instead.
		const result = await asked

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("re-checks a queued command drained at ask entry with no approval context", async () => {
		openTwoFolders()
		// A message is already queued and the claim gate is open, so the entry drain
		// performs the re-check. Folder A's entry approves.
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			getState: async () => commandState({ alwaysDenyUnapprovedCommands: false }),
		}
		const task = buildTask(provider, FOLDER_A)
		await attachQueue(task)
		task.messageQueueService.addMessage("run it")

		// Without approval context the entry re-check uses the task folder.
		// A throw there is only logged, so the log is the witness.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("re-checks an entry-drained queued command against the task folder's policy once blanket deny engages", async () => {
		// Same entry drain, but blanket deny is engaged on the drain read. The task's
		// folder is now the second workspace folder. A fallback to the first folder,
		// which denies "echo", would deny, so the approval names the task folder.
		openTwoFolders()
		workspaceState.workspaceFolders = [
			{ fsPath: FOLDER_B, uri: { fsPath: FOLDER_B } },
			{ fsPath: FOLDER_A, uri: { fsPath: FOLDER_A } },
		]
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			// First read (ask time): blanket deny off, so the entry claim gate opens.
			// Second read (entry-drain re-check): blanket deny engaged.
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		const task = buildTask(provider, FOLDER_A)
		await attachQueue(task)
		task.messageQueueService.addMessage("run it")

		// No approval context: the re-check falls back to the task's directory,
		// where folder A's entry grants the approval.
		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("denies an entry-drained queued command whose task folder denies it, although the first workspace folder allows it", async () => {
		// The paired reject path. The task is in denying folder B, which is not the
		// first workspace folder. A fallback to the first folder would approve, so
		// the denial names the task's folder.
		openTwoFolders()
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		const task = buildTask(provider, FOLDER_B)
		await attachQueue(task)
		task.messageQueueService.addMessage("run it")

		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("denylist")
	})

	it("denies a drained queued command whose working directory the policy denies, although the blanket path would accept it", async () => {
		openTwoFolders()
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysAllowExecute: false, alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		// The task folder (A) allows. The command runs in B, which denies.
		const task = buildTask(provider, FOLDER_A)
		await attachQueue(task)

		const asked = task.ask("command", "echo hi", false, undefined, false, { commandCwd: FOLDER_B })
		await vi.waitUntil(() => (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls.length > 0)
		task.messageQueueService.addMessage("run it")

		const result = await asked

		expect(result.response).toBe("noButtonClicked")
		expect(result.autoDenyDetail?.kind).toBe("denylist")
	})
})
