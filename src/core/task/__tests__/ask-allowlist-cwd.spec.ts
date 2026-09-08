// npx vitest run core/task/__tests__/ask-allowlist-cwd.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"

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
	task["abort"] = false
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
