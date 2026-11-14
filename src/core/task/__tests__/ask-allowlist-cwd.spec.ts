// npx vitest run core/task/__tests__/ask-allowlist-cwd.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"

// Command-list enforcement resolves the command's cwd to a workspace folder and
// reads that folder's configuration; the shared module mock resolves every
// lookup to nothing, so these scriptable stand-ins (wrapping the real mock) are
// what let a command ask be judged by a named folder's allow/deny entries.
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

// Command asks: the per-folder command lists must judge the directory the
// command will actually run in (`commandCwd` from the tool's approval
// context), not the task folder — a task in folder A must not be able to ride
// folder A's allow entry to run a command in folder B. The raw global layers
// are set empty on the state so every decision below comes from the folder the
// command's cwd resolves to; the baked pair carries values no folder composes,
// so a check that consumed it instead of re-composing decides differently.

const FOLDER_A = "/mock/folder-a"
const FOLDER_B = "/mock/folder-b"

function openTwoFolders() {
	const folderA = { fsPath: FOLDER_A, uri: { fsPath: FOLDER_A } }
	const folderB = { fsPath: FOLDER_B, uri: { fsPath: FOLDER_B } }
	workspaceState.workspaceFolders = [folderA, folderB]
	workspaceState.foldersByPath.set(FOLDER_A, folderA.uri)
	workspaceState.foldersByPath.set(FOLDER_B, folderB.uri)
	// Folder A allows "echo" and folder B denies it, so a decision names the
	// folder that was read.
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
	// The task runs in folder A (whose allow entry must NOT approve a command
	// executing in folder B) — the task cwd equals folder A here.
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
	})

	it("approves a command whose custom cwd resolves to the folder that allows it", async () => {
		openTwoFolders()
		// Only folder B carries the entry, so approval can only come from the
		// folder the command runs in.
		workspaceState.configScripts[FOLDER_A] = { gate: true }
		workspaceState.configScripts[FOLDER_B] = { gate: true, allow: ["echo"] }

		expect(await askToRunCommand(FOLDER_B, commandState())).toBe("approve")
	})

	it("does not approve a command executing where the same entry is denied, although the task folder allows it", async () => {
		openTwoFolders()

		// The task folder (A) allows "echo"; the command runs in B, which denies
		// it. The deny layer must decide.
		expect(await askToRunCommand(FOLDER_B, commandState())).toBe("deny")
	})

	it("judges a custom cwd that names no workspace folder by the global layers only", async () => {
		openTwoFolders()

		// The baked pair would approve, but with the raw layers present the
		// command branch re-composes: an unmatched cwd drops the workspace
		// layer entirely, so nothing allows or denies "echo" and the user decides.
		expect(await askToRunCommand("/mock/removed-folder", commandState())).toBe("ask")
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
			// First read (ask time): blanket deny off, execute auto-approval off,
			// so the ask stays pending. Second read (drain re-check): blanket
			// deny engaged, so the queued message must re-earn its approval.
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysAllowExecute: false, alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		// The task is rooted in folder B (which denies "echo") while the command
		// runs in folder A (which allows it): a re-check that fell back to the
		// task folder would deny the queued approval the command's own folder
		// grants.
		const task = buildTask(provider, FOLDER_B)
		await attachQueue(task)

		const asked = task.ask("command", "echo hi", false, undefined, false, { commandCwd: FOLDER_A })
		await vi.waitUntil(() => (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls.length > 0)
		task.messageQueueService.addMessage("run it")

		// Folder A allows "echo"; had the re-check judged the task-independent
		// defaults or the baked pair, the blanket deny would reject the queued
		// approval. The folder the command runs in approves it.
		const result = await asked

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("re-checks a queued command drained at ask entry with no approval context", async () => {
		openTwoFolders()
		// A message already queued when the ask opens, with the claim gate open
		// (blanket deny off): the ENTRY drain (not the later pWaitFor one)
		// performs the policy re-check, and folder A's entry approves it.
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			getState: async () => commandState({ alwaysDenyUnapprovedCommands: false }),
		}
		const task = buildTask(provider, FOLDER_A)
		await attachQueue(task)
		task.messageQueueService.addMessage("run it")

		// No approval context at all: the entry re-check must run cleanly
		// against the task folder and approve via folder A's entry. A throw
		// there is caught and logged (then the pWaitFor drain would paper over
		// it), so the log is the witness.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("re-checks an entry-drained queued command against the task folder's policy once blanket deny engages", async () => {
		// Same entry drain as the no-context test above, but blanket deny is
		// engaged on the drain read, so the re-check reaches directory
		// selection instead of consuming the queued message as a legitimate
		// approval. The task's folder is made the SECOND workspace folder
		// (folder order swapped) while it allows "echo": a re-check that fell
		// back to the first workspace folder — which denies it — would deny,
		// so the approval names the task folder's directory.
		openTwoFolders()
		workspaceState.workspaceFolders = [
			{ fsPath: FOLDER_B, uri: { fsPath: FOLDER_B } },
			{ fsPath: FOLDER_A, uri: { fsPath: FOLDER_A } },
		]
		const provider: ProviderStub = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			cwd: PROVIDER_CWD,
			// First read (ask time): blanket deny off, so the entry claim gate
			// opens. Second read (entry-drain re-check): blanket deny engaged,
			// so the queued message must re-earn its approval.
			getState: vi
				.fn()
				.mockResolvedValueOnce(commandState({ alwaysDenyUnapprovedCommands: false }))
				.mockResolvedValue(commandState({ alwaysDenyUnapprovedCommands: true })),
		}
		const task = buildTask(provider, FOLDER_A)
		await attachQueue(task)
		task.messageQueueService.addMessage("run it")

		// No approval context: the re-check falls back to the task's own
		// directory, where folder A's entry grants the queued approval.
		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.autoDenyDetail).toBeUndefined()
	})

	it("denies an entry-drained queued command whose task folder denies it, although the first workspace folder allows it", async () => {
		// The paired reject path: the task is rooted in folder B (which denies
		// "echo") and folder B is NOT the first workspace folder. With blanket
		// deny engaged on the drain read, the re-check selects the task
		// folder's directory; a fallback to the first workspace folder (which
		// allows "echo") would approve, so the denial names the folder the
		// task actually runs in.
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
		// The task folder (A) allows; the command runs in B, which denies.
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
