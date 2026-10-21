// cd src && npx vitest run core/task/__tests__/Task.resumeApiHistoryPersistence.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import type { HistoryItem, PendingTaskAction } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { LifecycleTransitionError } from "../../task-persistence"
import type { ApiMessage } from "../../task-persistence/apiMessages"

// The store, the message persistence helpers, and the per-task files all run
// for real. Only the editor shell and external integrations are mocked. The
// fs/promises rename wrapper stays real unless a test injects a failure.
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, rename: vi.fn(actual.rename) }
})

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(() => ({ dispose: vi.fn() })),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
				showErrorMessage: vi.fn(),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text: string) => {
		return Promise.resolve({ text, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", () => ({
	CondenseContext: vi.fn(),
	summarizeTask: vi.fn().mockResolvedValue({ success: false }),
	// The seeded histories hold no condensation markers, so the identity
	// mapping matches the real filter for these tests.
	getEffectiveApiHistory: vi.fn((messages: unknown[]) => messages),
}))

type TaskTestAccess = {
	initiateTaskLoop: (userContent: unknown[]) => Promise<void>
	retrySaveApiConversationHistory: () => Promise<boolean>
}

function taskAccess(task: Task): TaskTestAccess {
	return task as unknown as TaskTestAccess
}

const childId = "resume-child"
const parentId = "resume-parent"

const authoritativeApiHistory: ApiMessage[] = [
	{ role: "user", content: [{ type: "text", text: "first user message" }], ts: 1, messageId: "m-1" },
	{ role: "assistant", content: "assistant reply", ts: 2, messageId: "m-2" },
	{ role: "user", content: [{ type: "text", text: "last user message" }], ts: 3, messageId: "m-3" },
]

// The preparation slice the resume writes before activation: the prepared
// history drops the last user message, which moves into the task loop input.
const preparedApiHistory = authoritativeApiHistory.slice(0, -1)

function makeChildRecord(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: childId,
		number: 1,
		ts: 1,
		task: "Child task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/mock/workspace/path",
		status: "interrupted",
		parentTaskId: parentId,
		rootTaskId: parentId,
		...overrides,
	}
}

async function seedTaskFiles(storagePath: string, taskId: string, apiMessages: ApiMessage[]): Promise<string> {
	const taskDir = path.join(storagePath, "tasks", taskId)
	await fs.mkdir(taskDir, { recursive: true })
	await fs.writeFile(path.join(taskDir, GlobalFileNames.uiMessages), "[]", "utf8")
	await fs.writeFile(path.join(taskDir, GlobalFileNames.apiConversationHistory), JSON.stringify(apiMessages), "utf8")
	return taskDir
}

async function readPersistedApiHistory(storagePath: string, taskId: string): Promise<ApiMessage[]> {
	const filePath = path.join(storagePath, "tasks", taskId, GlobalFileNames.apiConversationHistory)
	return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function readPersistedRecord(storagePath: string, taskId: string): Promise<Record<string, unknown>> {
	const filePath = path.join(storagePath, "tasks", taskId, GlobalFileNames.historyItem)
	return JSON.parse(await fs.readFile(filePath, "utf8"))
}

function findRecoveryCopyName(taskDir: string): Promise<string | undefined> {
	return fs.readdir(taskDir).then((names) => names.find((name) => name.includes(".pre-resume-")))
}

describe("Task resume api-history persistence on real files", () => {
	let storagePath: string
	let provider: ClineProvider & Record<string, unknown>
	const realRename = vi.mocked(fs.rename).getMockImplementation()!

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-resume-api-history-"))

		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: storagePath },
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
			new WebviewFocusTracker(),
		) as ClineProvider & Record<string, unknown>

		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.log = vi.fn()

		await provider.taskHistoryStore.initialize()
	})

	afterEach(async () => {
		provider.taskHistoryStore.dispose()
		vi.mocked(fs.rename).mockImplementation(realRename)
		await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {})
	})

	function prepareResumedTask(history: HistoryItem): {
		task: Task
		loop: ReturnType<typeof vi.fn>
		resumeActivation: ReturnType<typeof vi.spyOn>
	} {
		const task = new Task({
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-sonnet-20241022",
				apiKey: "test-api-key",
			},
			historyItem: history,
			startTask: false,
		})
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		const loop = vi.fn().mockResolvedValue(undefined)
		vi.spyOn(taskAccess(task), "initiateTaskLoop").mockImplementation(loop)
		const resumeActivation = vi.spyOn(provider, "resumeInterruptedTask")
		return { task, loop, resumeActivation }
	}

	it("commits the resume and keeps the prepared history when the parent still awaits the child", async () => {
		await provider.taskHistoryStore.upsert({
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: childId,
			delegatedToId: childId,
			childIds: [childId],
		} as HistoryItem)
		await provider.taskHistoryStore.upsert(makeChildRecord())
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		const { task, loop } = prepareResumedTask(makeChildRecord())
		await task["resumeTaskFromHistory"]()

		expect(loop).toHaveBeenCalledTimes(1)
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(preparedApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("active")
		expect(provider.taskHistoryStore.get(childId)?.status).toBe("active")
		// The resume committed, so no pre-resume recovery copy remains.
		expect(await findRecoveryCopyName(taskDir)).toBeUndefined()
	})

	it("restores the persisted api history and keeps the record interrupted when the locked resume rejects a stale parent", async () => {
		// The parent no longer awaits the child, so the locked commit rejects.
		await provider.taskHistoryStore.upsert({
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "active",
		} as HistoryItem)
		await provider.taskHistoryStore.upsert(makeChildRecord())
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		const { task, loop, resumeActivation } = prepareResumedTask(makeChildRecord())

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("no longer awaits it")

		expect(resumeActivation).toHaveBeenCalledTimes(1)
		expect(loop).not.toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(authoritativeApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		expect(persistedRecord.parentTaskId).toBe(parentId)
		expect(provider.taskHistoryStore.get(childId)?.status).toBe("interrupted")
		// The restore succeeded, so the pre-resume copy was removed.
		expect(await findRecoveryCopyName(taskDir)).toBeUndefined()
	})

	it("re-interrupts an aborted child and restores the pre-resume history after the commit lands", async () => {
		await provider.taskHistoryStore.upsert({
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: childId,
			delegatedToId: childId,
			childIds: [childId],
		} as HistoryItem)
		await provider.taskHistoryStore.upsert(makeChildRecord())
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		const { task, loop, resumeActivation } = prepareResumedTask(makeChildRecord())
		const reinterrupt = vi.spyOn(provider, "reinterruptAbandonedChild")
		// A cancel racing the commit flips the abort flag while the locked
		// activation is in flight, after the cancel's own interruption marking
		// no-op'd on the still-interrupted record.
		resumeActivation.mockImplementation(async (taskId: string, parentTaskId?: string) => {
			await ClineProvider.prototype.resumeInterruptedTask.call(provider, taskId, parentTaskId)
			task.abort = true
		})

		await task["resumeTaskFromHistory"]()

		expect(reinterrupt).toHaveBeenCalledWith({ childTaskId: childId, parentTaskId: parentId })
		expect(loop).not.toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(authoritativeApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		expect(provider.taskHistoryStore.get(childId)?.status).toBe("interrupted")
		const parent = provider.taskHistoryStore.get(parentId)
		expect(parent?.status).toBe("delegated")
		expect(parent?.awaitingChildId).toBe(childId)
		// The restore succeeded, so the pre-resume copy was removed.
		expect(await findRecoveryCopyName(taskDir)).toBeUndefined()
	})

	it("keeps a standalone aborted task active and retains the recovery copy after the commit lands", async () => {
		// A standalone record has no parent transition, so the committed
		// active status stands. The restore must still run so its
		// committed_elsewhere gate retains the recovery copy, and the task
		// loop must not start on the aborted runner.
		const standaloneRecord = makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined })
		await provider.taskHistoryStore.upsert(standaloneRecord)
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		const { task, loop, resumeActivation } = prepareResumedTask(standaloneRecord)
		const reinterrupt = vi.spyOn(provider, "reinterruptAbandonedChild")
		// A cancel racing the commit flips the abort flag while the
		// activation is in flight.
		resumeActivation.mockImplementation(async (taskId: string, parentTaskId?: string) => {
			await ClineProvider.prototype.resumeInterruptedTask.call(provider, taskId, parentTaskId)
			task.abort = true
		})

		await task["resumeTaskFromHistory"]()

		expect(reinterrupt).not.toHaveBeenCalled()
		expect(loop).not.toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(preparedApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("active")
		expect(provider.taskHistoryStore.get(childId)?.status).toBe("active")
		// The record is active, so no restore write ran. The recovery copy
		// stays on disk with the pre-resume history for recovery.
		const recoveryCopyName = await findRecoveryCopyName(taskDir)
		expect(recoveryCopyName).toBeDefined()
		const recoveryCopy = JSON.parse(await fs.readFile(path.join(taskDir, recoveryCopyName as string), "utf8"))
		expect(recoveryCopy).toEqual(authoritativeApiHistory)
	})

	it("stops before activation and keeps the persisted api history when the preparation write fails", async () => {
		await provider.taskHistoryStore.upsert(makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }))
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			const targetsApiHistory =
				String(newPath).endsWith(GlobalFileNames.apiConversationHistory) && String(oldPath).includes(".new_")
			if (targetsApiHistory) {
				throw new Error("injected api history rename failure")
			}
			return realRename(oldPath, newPath)
		})

		const { task, loop, resumeActivation } = prepareResumedTask(
			makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }),
		)

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow(
			"Failed to persist the prepared API conversation history",
		)

		expect(resumeActivation).not.toHaveBeenCalled()
		expect(loop).not.toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(authoritativeApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		// The safeWriteJson rollback restored the original on disk, so the
		// durable pre-resume copy is no longer the only recoverable original.
		// It stays on disk anyway, because the rollback itself could have failed.
		const recoveryCopyName = await findRecoveryCopyName(taskDir)
		expect(recoveryCopyName).toBeDefined()
		expect(await fs.readFile(path.join(taskDir, recoveryCopyName!), "utf8")).toBe(
			JSON.stringify(authoritativeApiHistory),
		)
	})

	it("restores the persisted api history when the task aborts after preparation and before activation", async () => {
		await provider.taskHistoryStore.upsert(makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }))
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		const { task, loop, resumeActivation } = prepareResumedTask(
			makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }),
		)
		const realOverwrite = task.overwriteApiConversationHistory.bind(task)
		vi.spyOn(task, "overwriteApiConversationHistory").mockImplementation(async (history, persist) => {
			const result = await realOverwrite(history, persist)
			await task.abortTask(true)
			return result
		})

		await task["resumeTaskFromHistory"]()

		expect(resumeActivation).not.toHaveBeenCalled()
		expect(loop).not.toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(authoritativeApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		expect(await findRecoveryCopyName(taskDir)).toBeUndefined()
	})

	it("reports a partial failure and proves the original bytes in the recovery copy when the restore write fails", async () => {
		await provider.taskHistoryStore.upsert({
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "active",
		} as HistoryItem)
		await provider.taskHistoryStore.upsert(makeChildRecord())
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		// The preparation commit lands. The restore commit fails once and the
		// safeWriteJson rollback restores the prepared slice on disk.
		let apiCommitRenames = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			const targetsApiHistory =
				String(newPath).endsWith(GlobalFileNames.apiConversationHistory) && String(oldPath).includes(".new_")
			if (targetsApiHistory) {
				apiCommitRenames++
				if (apiCommitRenames > 1) {
					throw new Error("injected restore rename failure")
				}
			}
			return realRename(oldPath, newPath)
		})

		const { task, loop } = prepareResumedTask(makeChildRecord())
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("no longer awaits it")

		expect(loop).not.toHaveBeenCalled()
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("partial failure"), expect.anything())
		consoleError.mockRestore()
		// The prepared slice is what remains on disk.
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(persisted).toEqual(preparedApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		const leftovers = await fs.readdir(taskDir)
		expect(leftovers.some((name) => name.includes(".bak_"))).toBe(false)
		// The durable pre-resume copy holds the exact original bytes under an
		// identifiable name, so a restart can recover the interrupted task.
		const recoveryCopyName = leftovers.find((name) => name.includes(".pre-resume-"))
		expect(recoveryCopyName).toBeDefined()
		expect(await fs.readFile(path.join(taskDir, recoveryCopyName!), "utf8")).toBe(
			JSON.stringify(authoritativeApiHistory),
		)
	})

	it("never clobbers a newer foreign history that lands before the restore commit", async () => {
		await provider.taskHistoryStore.upsert({
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "active",
		} as HistoryItem)
		await provider.taskHistoryStore.upsert(makeChildRecord())
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		// A competing host writes newer history after our preparation and
		// right before our activation rejects. The restore must honor it.
		const foreignHistory: ApiMessage[] = [
			...preparedApiHistory,
			{ role: "assistant", content: "foreign host progress", ts: 4, messageId: "m-foreign" },
		]
		const { task, loop } = prepareResumedTask(makeChildRecord())
		vi.mocked(provider.resumeInterruptedTask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			await fs.writeFile(
				path.join(taskDir, GlobalFileNames.apiConversationHistory),
				JSON.stringify(foreignHistory),
				"utf8",
			)
			throw new LifecycleTransitionError("parent linkage changed")
		})
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("parent linkage changed")

		expect(loop).not.toHaveBeenCalled()
		// The foreign history is the last content on disk, so the restore did
		// not clobber it with the pre-resume content.
		expect(await readPersistedApiHistory(storagePath, childId)).toEqual(foreignHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		// The original stays recoverable in the named copy, because the
		// foreign content won the file and the pre-resume history did not.
		const recoveryCopyName = await findRecoveryCopyName(taskDir)
		expect(recoveryCopyName).toBeDefined()
		expect(await fs.readFile(path.join(taskDir, recoveryCopyName!), "utf8")).toBe(
			JSON.stringify(authoritativeApiHistory),
		)
		consoleWarn.mockRestore()
	})

	it("fails closed and keeps the recovery copy when the record status is unreadable", async () => {
		await provider.taskHistoryStore.upsert(makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }))
		const taskDir = await seedTaskFiles(storagePath, childId, authoritativeApiHistory)

		// The record becomes unreadable right before our activation rejects,
		// so the restore cannot learn the authoritative status.
		const { task, loop } = prepareResumedTask(makeChildRecord({ parentTaskId: undefined, rootTaskId: undefined }))
		vi.mocked(provider.resumeInterruptedTask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			await fs.writeFile(path.join(taskDir, GlobalFileNames.historyItem), "not json", "utf8")
			throw new LifecycleTransitionError("parent linkage changed")
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("parent linkage changed")

		expect(loop).not.toHaveBeenCalled()
		// The restore failed closed: the disk keeps the prepared slice and the
		// pre-resume copy keeps the original bytes.
		expect(await readPersistedApiHistory(storagePath, childId)).toEqual(preparedApiHistory)
		const recoveryCopyName = await findRecoveryCopyName(taskDir)
		expect(recoveryCopyName).toBeDefined()
		expect(await fs.readFile(path.join(taskDir, recoveryCopyName!), "utf8")).toBe(
			JSON.stringify(authoritativeApiHistory),
		)
		consoleError.mockRestore()
	})
})

describe("Task.resumePendingTaskAction denial persistence on real files", () => {
	let storagePath: string
	let provider: ClineProvider & Record<string, unknown>
	const realRename = vi.mocked(fs.rename).getMockImplementation()!

	const finishAction: PendingTaskAction = {
		kind: "finish_subtask",
		actionId: "finish-action-1",
		approvalText: "{}",
		parentTaskId: parentId,
		result: "Done",
	}

	// The pending denial answers this tool call, so the seeded history ends
	// with the assistant turn that requested it.
	const denialApiHistory: ApiMessage[] = [
		{ role: "user", content: [{ type: "text", text: "do the thing" }], ts: 1, messageId: "m-1" },
		{
			role: "assistant",
			content: [{ type: "tool_use", id: finishAction.actionId, name: "finish_subtask", input: {} }],
			ts: 2,
			messageId: "m-2",
		},
	]

	function makeDelegatedParent(): HistoryItem {
		return {
			id: parentId,
			number: 2,
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: childId,
			delegatedToId: childId,
			childIds: [childId],
		}
	}

	function makePendingChildRecord(): HistoryItem {
		return makeChildRecord({ pendingAction: finishAction })
	}

	function prepareDeniedTask(history: HistoryItem): { task: Task; resumeActivation: ReturnType<typeof vi.spyOn> } {
		const task = new Task({
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-sonnet-20241022",
				apiKey: "test-api-key",
			},
			historyItem: history,
			startTask: false,
		})
		vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		const resumeActivation = vi.spyOn(provider, "resumeInterruptedTask")
		return { task, resumeActivation }
	}

	function countDenialResults(messages: ApiMessage[]): number {
		return messages.filter(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some(
					(block) =>
						block.type === "tool_result" &&
						(block as { tool_use_id?: string }).tool_use_id === finishAction.actionId,
				),
		).length
	}

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-denial-persistence-"))

		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: storagePath },
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
			new WebviewFocusTracker(),
		) as ClineProvider & Record<string, unknown>

		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.log = vi.fn()

		await provider.taskHistoryStore.initialize()
	})

	afterEach(async () => {
		provider.taskHistoryStore.dispose()
		vi.mocked(fs.rename).mockImplementation(realRename)
		await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {})
	})

	it("persists the denial result before activation and settles the action once", async () => {
		await provider.taskHistoryStore.upsert(makeDelegatedParent())
		await provider.taskHistoryStore.upsert(makePendingChildRecord())
		await seedTaskFiles(storagePath, childId, denialApiHistory)

		const { task, resumeActivation } = prepareDeniedTask(makePendingChildRecord())
		// Drive exactly one real assistant turn through the resumed task; the
		// abandoned exit stops the loop right after the stream. The spy also
		// keeps the mocked request off the network.
		vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
			(async function* () {
				yield { type: "text" as const, text: "understood" }
				task["abandoned"] = true
			})(),
		)
		// The real model-metadata fetch reaches outside the test scope, so the
		// turn runs on the stubbed seam like the other loop-driving suites.
		const loopAccess = task as unknown as { safeEnsureModelFetched: () => Promise<unknown> }
		loopAccess.safeEnsureModelFetched = vi.fn().mockResolvedValue(undefined)

		await task["resumeTaskFromHistory"]()

		expect(resumeActivation).toHaveBeenCalledTimes(1)
		// The loop entered its first turn: the denial turn posts its
		// api_req_started state before the request.
		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalled()
		const persisted = await readPersistedApiHistory(storagePath, childId)
		// The denial result is on disk exactly once: the pre-activation write
		// committed it, and the loop's first turn did not append it again.
		expect(countDenialResults(persisted)).toBe(1)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("active")
		// The durable denial settled the pending action.
		expect(persistedRecord.pendingAction).toBeUndefined()
		expect(provider.taskHistoryStore.get(childId)?.status).toBe("active")
		expect(provider.taskHistoryStore.get(childId)?.pendingAction).toBeUndefined()
	})

	it("stops before activation and keeps the pending action durable when the denial result fails to persist", async () => {
		await provider.taskHistoryStore.upsert(makeDelegatedParent())
		await provider.taskHistoryStore.upsert(makePendingChildRecord())
		await seedTaskFiles(storagePath, childId, denialApiHistory)

		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			const targetsApiHistory =
				String(newPath).endsWith(GlobalFileNames.apiConversationHistory) && String(oldPath).includes(".new_")
			if (targetsApiHistory) {
				throw new Error("injected api history rename failure")
			}
			return realRename(oldPath, newPath)
		})

		const { task, resumeActivation } = prepareDeniedTask(makePendingChildRecord())
		const request = vi.spyOn(task, "attemptApiRequest")

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("Failed to persist the denial result")

		expect(resumeActivation).not.toHaveBeenCalled()
		expect(request).not.toHaveBeenCalled()
		// The disk keeps the authoritative history and the retryable record.
		expect(await readPersistedApiHistory(storagePath, childId)).toEqual(denialApiHistory)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		expect(persistedRecord.pendingAction).toMatchObject({ actionId: finishAction.actionId })
		// The unpersisted append is dropped from memory, so no later save from
		// this instance can persist the denial from here.
		expect(task.apiConversationHistory).toEqual(denialApiHistory)
	})

	it("keeps the denial durable and settled when the stale parent rejects the activation", async () => {
		// The parent no longer awaits the child, so the locked commit rejects.
		await provider.taskHistoryStore.upsert({ ...makeDelegatedParent(), status: "active" })
		await provider.taskHistoryStore.upsert(makePendingChildRecord())
		await seedTaskFiles(storagePath, childId, denialApiHistory)

		const { task, resumeActivation } = prepareDeniedTask(makePendingChildRecord())
		const request = vi.spyOn(task, "attemptApiRequest")

		await expect(task["resumeTaskFromHistory"]()).rejects.toThrow("no longer awaits it")

		expect(resumeActivation).toHaveBeenCalledTimes(1)
		expect(request).not.toHaveBeenCalled()
		// The committed denial stays on disk; it is a settled user decision,
		// not an unaccepted prepared slice, so no restore removes it.
		const persisted = await readPersistedApiHistory(storagePath, childId)
		expect(countDenialResults(persisted)).toBe(1)
		const persistedRecord = await readPersistedRecord(storagePath, childId)
		expect(persistedRecord.status).toBe("interrupted")
		expect(persistedRecord.pendingAction).toBeUndefined()
	})
})
