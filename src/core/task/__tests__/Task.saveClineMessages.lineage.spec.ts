// cd src && npx vitest run core/task/__tests__/Task.saveClineMessages.lineage.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import type { ClineMessage, HistoryItem } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Only the message persistence helpers are mocked. The store, the metadata
// builder, the provider routing, and the per-task file writes all run for real.
vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: vi.fn().mockResolvedValue(undefined),
		saveTaskMessages: vi.fn().mockResolvedValue(undefined),
		readApiMessages: vi.fn().mockResolvedValue([]),
		readTaskMessages: vi.fn().mockResolvedValue([]),
	}
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
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
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
}))

type SaveClineMessagesAccess = { saveClineMessages: () => Promise<boolean> }

function makeLinkedInterruptedHistory(id: string): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: "Delegated child",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/mock/workspace/path",
		status: "interrupted",
		parentTaskId: "parent-1",
		rootTaskId: "root-1",
	}
}

function makeMessages(): ClineMessage[] {
	// The first rehydrated message is the original task say. Its text feeds
	// the metadata title, so it must match the persisted child title.
	return [
		{ ts: 1, type: "say", say: "text", text: "Delegated child" },
		{ ts: 2, type: "say", say: "text", text: "Rehydrated child progress" },
	]
}

async function readPersistedRecord(storagePath: string, taskId: string): Promise<Record<string, unknown>> {
	const filePath = path.join(storagePath, "tasks", taskId, "history_item.json")
	return JSON.parse(await fs.readFile(filePath, "utf8"))
}

describe("Task.saveClineMessages lineage ownership for rehydrated interrupted tasks", () => {
	let storagePath: string
	let provider: ClineProvider & Record<string, unknown>

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-save-lineage-"))

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
		await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {})
	})

	async function createRehydratedTask(history: HistoryItem): Promise<Task> {
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
		// Hydrate the rehydrated messages without persisting them. The tested
		// save then matches the production resume flow, where cline messages
		// are hydrated before the first metadata save.
		task.clineMessages = makeMessages()
		return task
	}

	it("recreates a record deleted by another host without stale lineage", async () => {
		const history = makeLinkedInterruptedHistory("detached-child")
		await provider.taskHistoryStore.upsert(history)

		// The local cache stays linked. Another host removes the record.
		await fs.rm(path.join(storagePath, "tasks", "detached-child"), { recursive: true, force: true })
		expect(provider.taskHistoryStore.get("detached-child")?.parentTaskId).toBe("parent-1")

		const task = await createRehydratedTask(history)
		await (task as unknown as SaveClineMessagesAccess).saveClineMessages()

		const persisted = await readPersistedRecord(storagePath, "detached-child")
		expect(persisted).not.toHaveProperty("parentTaskId")
		expect(persisted).not.toHaveProperty("rootTaskId")
		expect(persisted.status).toBe("interrupted")
		expect(persisted.task).toBe("Delegated child")
		expect(provider.taskHistoryStore.get("detached-child")).not.toHaveProperty("parentTaskId")
	})

	it("keeps a record detached by another host after a stale save", async () => {
		const history = makeLinkedInterruptedHistory("detached-child")
		await provider.taskHistoryStore.upsert(history)

		// Another host detaches the authoritative record on disk only.
		const detached = { ...history } as Record<string, unknown>
		delete detached.parentTaskId
		delete detached.rootTaskId
		await fs.writeFile(
			path.join(storagePath, "tasks", "detached-child", "history_item.json"),
			JSON.stringify(detached, null, "\t"),
			"utf8",
		)
		expect(provider.taskHistoryStore.get("detached-child")?.parentTaskId).toBe("parent-1")

		const task = await createRehydratedTask(history)
		await (task as unknown as SaveClineMessagesAccess).saveClineMessages()

		const persisted = await readPersistedRecord(storagePath, "detached-child")
		expect(persisted).not.toHaveProperty("parentTaskId")
		expect(persisted).not.toHaveProperty("rootTaskId")
		expect(persisted.status).toBe("interrupted")
		expect(persisted.task).toBe("Delegated child")
		expect(provider.taskHistoryStore.get("detached-child")).not.toHaveProperty("parentTaskId")
	})

	it("preserves valid authoritative lineage through a message save", async () => {
		const history = makeLinkedInterruptedHistory("linked-child")
		await provider.taskHistoryStore.upsert(history)

		const task = await createRehydratedTask(history)
		await (task as unknown as SaveClineMessagesAccess).saveClineMessages()

		const persisted = await readPersistedRecord(storagePath, "linked-child")
		expect(persisted.parentTaskId).toBe("parent-1")
		expect(persisted.rootTaskId).toBe("root-1")
		expect(persisted.status).toBe("interrupted")
		expect(persisted.task).toBe("Delegated child")
		expect(provider.taskHistoryStore.get("linked-child")).toMatchObject({
			parentTaskId: "parent-1",
			rootTaskId: "root-1",
		})
	})
})
