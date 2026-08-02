import { describe, it, expect, vi, beforeEach } from "vitest"

import type { WebviewMessage, TaskOrganizationMutationResultV1 } from "@roo-code/types"
import { createEmptyTaskOrganizationState } from "@roo-code/types"

import type { ClineProvider } from "../ClineProvider"
import { handleTaskOrganizationMessage } from "../taskOrganizationMessageHandler"

// ── Mock Provider Factory ────────────────────────────────────────────────────

const createMockProvider = (mutateResult: TaskOrganizationMutationResultV1): ClineProvider => {
	const mockLog = vi.fn()
	const mockPostMessageToWebview = vi.fn()
	const mockMutate = vi.fn().mockResolvedValue(mutateResult)
	const mockState = createEmptyTaskOrganizationState()

	const store = {
		mutate: mockMutate,
		getState: vi.fn(() => mockState),
	}

	return {
		log: mockLog,
		postMessageToWebview: mockPostMessageToWebview,
		getTaskOrganizationStore: vi.fn(() => store),
	} as unknown as ClineProvider
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleTaskOrganizationMessage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("validates and forwards a createFolder mutation", async () => {
		const result: TaskOrganizationMutationResultV1 = {
			requestId: "req-create",
			success: true,
			committedRevision: 1,
		}
		const provider = createMockProvider(result)

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-create",
				baseRevision: 0,
				mutation: {
					kind: "createFolder",
					folderId: "folder-1",
					name: "My Folder",
					source: { kind: "task", taskId: "task-a" },
					destination: { kind: "task", taskId: "task-b" },
				},
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		const store = provider.getTaskOrganizationStore()
		expect(store.mutate).toHaveBeenCalledWith(
			{
				kind: "createFolder",
				folderId: "folder-1",
				name: "My Folder",
				source: { kind: "task", taskId: "task-a" },
				destination: { kind: "task", taskId: "task-b" },
			},
			0,
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-create",
			taskOrganizationMutationResult: result,
		})
	})

	it("returns a validation error for a malformed request", async () => {
		const provider = createMockProvider({
			requestId: "ignored",
			success: true,
			committedRevision: 0,
		})

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-bad",
				baseRevision: 0,
				mutation: {
					kind: "createFolder",
					// Missing required fields
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any,
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		expect(provider.getTaskOrganizationStore().mutate).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-bad",
			taskOrganizationMutationResult: {
				requestId: "req-bad",
				success: false,
				committedRevision: 0,
				error: {
					code: "TASK_ORG/VALIDATION/001",
					message: expect.stringContaining("Invalid mutation request"),
				},
			},
		})
	})

	it("returns a typed error when the store rejects the mutation", async () => {
		const result: TaskOrganizationMutationResultV1 = {
			requestId: "req-limit",
			success: false,
			committedRevision: 0,
			error: {
				code: "TASK_ORG/PIN_LIMIT/003",
				message: "Maximum three pins allowed.",
			},
		}
		const provider = createMockProvider(result)

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-limit",
				baseRevision: 0,
				mutation: {
					kind: "setPinned",
					target: { kind: "task", taskId: "task-x" },
					pinned: true,
				},
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-limit",
			taskOrganizationMutationResult: result,
		})
	})

	it("validates and forwards a createFolderFromSelection mutation", async () => {
		const result: TaskOrganizationMutationResultV1 = {
			requestId: "req-cfs",
			success: true,
			committedRevision: 1,
		}
		const provider = createMockProvider(result)

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-cfs",
				baseRevision: 0,
				mutation: {
					kind: "createFolderFromSelection",
					folderId: "folder-sel",
					name: "Selection Folder",
					targets: [
						{ kind: "task", taskId: "task-a" },
						{ kind: "task", taskId: "task-b" },
						{ kind: "task", taskId: "task-c" },
					],
				},
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		const store = provider.getTaskOrganizationStore()
		expect(store.mutate).toHaveBeenCalledWith(
			{
				kind: "createFolderFromSelection",
				folderId: "folder-sel",
				name: "Selection Folder",
				targets: [
					{ kind: "task", taskId: "task-a" },
					{ kind: "task", taskId: "task-b" },
					{ kind: "task", taskId: "task-c" },
				],
			},
			0,
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-cfs",
			taskOrganizationMutationResult: result,
		})
	})

	it("validates and forwards a deleteFolders mutation", async () => {
		const result: TaskOrganizationMutationResultV1 = {
			requestId: "req-df",
			success: true,
			committedRevision: 2,
		}
		const provider = createMockProvider(result)

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-df",
				baseRevision: 1,
				mutation: {
					kind: "deleteFolders",
					folderIds: ["folder-1", "folder-2"],
				},
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		const store = provider.getTaskOrganizationStore()
		expect(store.mutate).toHaveBeenCalledWith(
			{
				kind: "deleteFolders",
				folderIds: ["folder-1", "folder-2"],
			},
			1,
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-df",
			taskOrganizationMutationResult: result,
		})
	})

	it("survives unexpected store errors and returns a sanitized persistence error", async () => {
		const provider = {
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
			getTaskOrganizationStore: vi.fn(() => ({
				mutate: vi.fn().mockRejectedValue(new Error("disk full")),
				getState: vi.fn(() => createEmptyTaskOrganizationState()),
			})),
		} as unknown as ClineProvider

		const message: WebviewMessage = {
			type: "taskOrganizationMutation",
			taskOrganizationMutation: {
				requestId: "req-boom",
				baseRevision: 0,
				mutation: {
					kind: "renameFolder",
					folderId: "folder-1",
					name: "Renamed",
				},
			},
		}

		await handleTaskOrganizationMessage(provider, message)

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskOrganizationMutationResult",
			requestId: "req-boom",
			taskOrganizationMutationResult: {
				requestId: "req-boom",
				success: false,
				committedRevision: 0,
				error: {
					code: "TASK_ORG/PERSISTENCE/005",
					message: "Organization data could not be saved.",
				},
			},
		})
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("TASK_ORG/HANDLER/001"))
	})
})
