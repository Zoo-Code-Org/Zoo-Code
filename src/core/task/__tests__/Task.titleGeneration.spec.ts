import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProviderSettings, HistoryItem } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import { Task } from "../Task"
import * as taskTitleGen from "../taskTitleGenerator"
import { setAbortLatch } from "../../../test-utils/run-state"

vi.mock("../taskTitleGenerator", () => ({
	generateTaskTitle: vi.fn(),
}))

type TaskTitleAccess = {
	generateTitleInBackground(taskText: string): Promise<void>
	startTask(task?: string, images?: string[]): Promise<void>
	cancelCurrentRequest(): void
	requestAbort(isAbandoned: boolean): void
	titleAbortController?: AbortController
	abort: boolean
	abandoned: boolean
	taskId: string
	instanceId: string
	apiConfiguration: ProviderSettings
	parentTask?: Task
	metadata: { task?: string; images?: string[] }
}

const getTaskTitleAccess = (task: Task) => task as unknown as TaskTitleAccess

describe("Task title generation", () => {
	const mockApiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-key",
	}

	let mockHistoryStore: Map<string, HistoryItem>
	let mockRenameTaskWithId: ReturnType<typeof vi.fn>
	let mockProvider: {
		renameTaskWithId: ReturnType<typeof vi.fn>
		taskHistoryStore: {
			get: (id: string) => HistoryItem | undefined
		}
		postStateToWebviewWithoutTaskHistory: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockHistoryStore = new Map()
		mockRenameTaskWithId = vi.fn().mockResolvedValue(undefined)
		mockProvider = {
			renameTaskWithId: mockRenameTaskWithId,
			taskHistoryStore: {
				get: (id: string) => mockHistoryStore.get(id),
			},
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		}
	})

	function createTestTask(options: { parentTask?: Task; initialTitle?: string } = {}) {
		const task = Object.create(Task.prototype) as Task
		setAbortLatch(task, false)
		const taskId = "task-title-1"
		mockHistoryStore.set(taskId, {
			id: taskId,
			ts: Date.now(),
			task: "Initial prompt message",
			title: options.initialTitle,
		} as HistoryItem)

		Object.assign(task, {
			taskId,
			instanceId: "inst-1",
			apiConfiguration: mockApiConfig,
			providerRef: { deref: () => mockProvider },
			abandoned: false,
			parentTask: options.parentTask,
			metadata: { task: "Initial prompt message" },
			say: vi.fn().mockResolvedValue(undefined),
			getEnabledMcpToolsCount: vi.fn().mockResolvedValue({ enabledToolCount: 0, enabledServerCount: 0 }),
			markInitialized: vi.fn(),
			initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
			driveRunEvent: vi.fn(),
		})

		return task
	}

	describe("generateTitleInBackground", () => {
		it("calls generateTaskTitle and updates task title via renameTaskWithId", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(taskTitleGen.generateTaskTitle).toHaveBeenCalledWith(
				"Initial prompt message",
				mockApiConfig,
				expect.objectContaining({
					taskId: "task-title-1",
					timeoutMs: 10000,
				}),
			)
			expect(mockRenameTaskWithId).toHaveBeenCalledWith("task-title-1", "Summarized Title")
		})

		it("does not call renameTaskWithId when generateTaskTitle returns undefined", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce(undefined)
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockRenameTaskWithId).not.toHaveBeenCalled()
		})

		it("does not overwrite if the task already has a custom title set", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const task = createTestTask({ initialTitle: "User Custom Title" })

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockRenameTaskWithId).not.toHaveBeenCalled()
		})

		it("does not call renameTaskWithId if task is aborted during generation", async () => {
			const task = createTestTask()
			vi.mocked(taskTitleGen.generateTaskTitle).mockImplementationOnce(async () => {
				setAbortLatch(task, true)
				return "Summarized Title"
			})

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockRenameTaskWithId).not.toHaveBeenCalled()
		})

		it("does not call renameTaskWithId if task is abandoned during generation", async () => {
			const task = createTestTask()
			vi.mocked(taskTitleGen.generateTaskTitle).mockImplementationOnce(async () => {
				task.abandoned = true
				return "Summarized Title"
			})

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(mockRenameTaskWithId).not.toHaveBeenCalled()
		})

		it("cleans up titleAbortController when finished", async () => {
			vi.mocked(taskTitleGen.generateTaskTitle).mockResolvedValueOnce("Summarized Title")
			const task = createTestTask()

			await getTaskTitleAccess(task).generateTitleInBackground("Initial prompt message")

			expect(getTaskTitleAccess(task).titleAbortController).toBeUndefined()
		})
	})

	describe("cancellation and abort handling", () => {
		it("aborts titleAbortController in cancelCurrentRequest", () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const controller = new AbortController()
			const abortSpy = vi.spyOn(controller, "abort")
			access.titleAbortController = controller

			access.cancelCurrentRequest()

			expect(abortSpy).toHaveBeenCalled()
			expect(access.titleAbortController).toBeUndefined()
		})

		it("aborts titleAbortController in requestAbort", () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const controller = new AbortController()
			const abortSpy = vi.spyOn(controller, "abort")
			access.titleAbortController = controller

			access.requestAbort(false)

			expect(abortSpy).toHaveBeenCalled()
			expect(access.titleAbortController).toBeUndefined()
		})
	})

	describe("startTask background trigger", () => {
		it("starts background title generation for top-level task with prompt", async () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask("Initial prompt message")

			expect(titleBgSpy).toHaveBeenCalledWith("Initial prompt message")
		})

		it("does not start title generation for child/subtasks", async () => {
			const parent = createTestTask()
			const child = createTestTask({ parentTask: parent })
			const access = getTaskTitleAccess(child)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask("Child subtask prompt")

			expect(titleBgSpy).not.toHaveBeenCalled()
		})

		it("does not start title generation when prompt is omitted", async () => {
			const task = createTestTask()
			const access = getTaskTitleAccess(task)
			const titleBgSpy = vi.spyOn(access, "generateTitleInBackground").mockResolvedValue(undefined)

			await access.startTask(undefined)

			expect(titleBgSpy).not.toHaveBeenCalled()
		})
	})
})
