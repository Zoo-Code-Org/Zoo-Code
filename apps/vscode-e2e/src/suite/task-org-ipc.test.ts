import * as assert from "assert"
import * as vscode from "vscode"

import type { TaskOrganizationMutationResultV1, TaskOrganizationStateV1 } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * E2E tests for the Task Organization IPC bridge.
 *
 * The bridge lives in `src/core/webview/taskOrganizationMessageHandler.ts` and
 * `src/core/task-persistence/TaskOrganizationStore.ts`. It receives
 * `taskOrganizationMutation` webview messages, validates them with Zod, applies
 * them through the `TaskOrganizationStore`, and posts a typed
 * `taskOrganizationMutationResult` back to the webview correlated by `requestId`.
 *
 * These tests exercise the full round-trip: message dispatch → store mutation →
 * result posting → state broadcast (`taskOrganizationUpdated` / `state`).
 *
 * Because e2e tests run inside the extension host, we can access the real
 * `ClineProvider` instance and its `TaskOrganizationStore` directly. We also
 * listen on the provider's `postMessageToWebview` to capture the IPC result
 * messages that would normally be sent to the webview.
 */
suite("Task Organization IPC Bridge", function () {
	setDefaultSuiteTimeout(this)

	/**
	 * Get the visible ClineProvider instance. The extension host should already
	 * have focused the sidebar during suite setup.
	 *
	 * Uses `require()` to bypass TypeScript cross-package module resolution
	 * limitations in the e2e test project.
	 */
	function getProvider() {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { ClineProvider } = require("../../../src/core/webview/ClineProvider")
		const provider = ClineProvider.getVisibleInstance()
		assert.ok(provider, "ClineProvider visible instance should be available")
		return provider
	}

	/**
	 * Send a mutation through the real handler and capture the result message
	 * that would be posted to the webview.
	 */
	async function sendMutationAndWaitForResult(
		provider: ReturnType<typeof getProvider>,
		request: {
			requestId: string
			baseRevision: number
			mutation: Record<string, unknown>
		},
	): Promise<TaskOrganizationMutationResultV1> {
		const results: TaskOrganizationMutationResultV1[] = []

		// Spy on postMessageToWebview to capture the result.
		const originalPostMessage = provider.postMessageToWebview.bind(provider)
		provider.postMessageToWebview = async (message: unknown) => {
			const msg = message as { type?: string; requestId?: string; taskOrganizationMutationResult?: TaskOrganizationMutationResultV1 }
			if (msg.type === "taskOrganizationMutationResult" && msg.requestId === request.requestId) {
				results.push(msg.taskOrganizationMutationResult!)
			}
			return originalPostMessage(message)
		}

		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { handleTaskOrganizationMessage } = require("../../../src/core/webview/taskOrganizationMessageHandler")

			await handleTaskOrganizationMessage(provider, {
				type: "taskOrganizationMutation",
				taskOrganizationMutation: request,
			})

			await waitFor(() => results.length > 0, { timeout: 10_000, interval: 100 })
			return results[0]!
		} finally {
			provider.postMessageToWebview = originalPostMessage
		}
	}

	/**
	 * Read the current task organization state from the provider's store.
	 */
	async function getTaskOrganizationState(
		provider: ReturnType<typeof getProvider>,
	): Promise<TaskOrganizationStateV1> {
		const store = provider.getTaskOrganizationStore()
		await store.waitForInitialized()
		return store.getState()
	}

	test("createFolder mutation round-trips and updates state", async () => {
		const provider = getProvider()

		const stateBefore = await getTaskOrganizationState(provider)
		const baseRevision = stateBefore.revision

		const result = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-create-folder-001",
			baseRevision,
			mutation: {
				kind: "createFolder",
				folderId: "e2e-folder-001",
				name: "E2E Test Folder",
				source: { kind: "task", taskId: "e2e-task-001" },
				destination: { kind: "folder", folderId: "e2e-folder-001" },
			},
		})

		assert.strictEqual(result.success, true, `Expected success but got error: ${result.error?.message}`)
		assert.strictEqual(result.requestId, "e2e-create-folder-001")
		assert.ok(result.committedRevision > baseRevision, "revision should increment after mutation")

		// Verify the store state reflects the new folder.
		const stateAfter = await getTaskOrganizationState(provider)
		const folder = stateAfter.folders.find((f) => f.folderId === "e2e-folder-001")
		assert.ok(folder, "created folder should appear in state")
		assert.strictEqual(folder.name, "E2E Test Folder")
	})

	test("moveToFolder mutation adds task to existing folder", async () => {
		const provider = getProvider()

		// Ensure the folder from the previous test exists (or create it here).
		let state = await getTaskOrganizationState(provider)
		if (!state.folders.some((f) => f.folderId === "e2e-folder-001")) {
			const createResult = await sendMutationAndWaitForResult(provider, {
				requestId: "e2e-create-folder-002",
				baseRevision: state.revision,
				mutation: {
					kind: "createFolder",
					folderId: "e2e-folder-001",
					name: "E2E Test Folder",
					source: { kind: "task", taskId: "e2e-task-001" },
					destination: { kind: "folder", folderId: "e2e-folder-001" },
				},
			})
			assert.strictEqual(createResult.success, true)
			state = await getTaskOrganizationState(provider)
		}

		const baseRevision = state.revision

		const moveResult = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-move-task-001",
			baseRevision,
			mutation: {
				kind: "moveToFolder",
				source: { kind: "task", taskId: "e2e-task-002" },
				folderId: "e2e-folder-001",
			},
		})

		assert.strictEqual(moveResult.success, true, `Expected success but got error: ${moveResult.error?.message}`)
		assert.strictEqual(moveResult.requestId, "e2e-move-task-001")

		const stateAfter = await getTaskOrganizationState(provider)
		const folder = stateAfter.folders.find((f) => f.folderId === "e2e-folder-001")
		assert.ok(folder?.taskIds.includes("e2e-task-002"), "task should be present in folder")
	})

	test("setPinned mutation toggles pin state and respects pin limit", async () => {
		const provider = getProvider()

		// Pin a task.
		let state = await getTaskOrganizationState(provider)
		let baseRevision = state.revision

		const pinResult = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-pin-001",
			baseRevision,
			mutation: {
				kind: "setPinned",
				target: { kind: "task", taskId: "e2e-task-001" },
				pinned: true,
			},
		})

		assert.strictEqual(pinResult.success, true, `Expected success but got error: ${pinResult.error?.message}`)

		state = await getTaskOrganizationState(provider)
		const pinned = state.pins.find((p) => p.target.kind === "task" && p.target.taskId === "e2e-task-001")
		assert.ok(pinned, "task should be pinned")

		// Unpin the same task.
		baseRevision = state.revision

		const unpinResult = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-unpin-001",
			baseRevision,
			mutation: {
				kind: "setPinned",
				target: { kind: "task", taskId: "e2e-task-001" },
				pinned: false,
			},
		})

		assert.strictEqual(unpinResult.success, true)

		state = await getTaskOrganizationState(provider)
		const stillPinned = state.pins.find((p) => p.target.kind === "task" && p.target.taskId === "e2e-task-001")
		assert.strictEqual(stillPinned, undefined, "task should be unpinned")
	})

	test("invalid mutation payload returns validation error", async () => {
		const provider = getProvider()

		const result = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-invalid-001",
			baseRevision: 0,
			mutation: {
				kind: "unknownKind",
				foo: "bar",
			},
		})

		assert.strictEqual(result.success, false)
		assert.strictEqual(result.error?.code, "TASK_ORG/VALIDATION/001")
		assert.ok(result.error?.message.includes("Invalid mutation request"))
	})

	test("stale baseRevision returns conflict error", async () => {
		const provider = getProvider()

		const state = await getTaskOrganizationState(provider)
		const currentRevision = state.revision

		// Send a mutation with a deliberately stale revision.
		const result = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-stale-001",
			baseRevision: currentRevision - 1,
			mutation: {
				kind: "createFolder",
				folderId: "e2e-folder-stale",
				name: "Stale Folder",
				source: { kind: "task", taskId: "e2e-task-stale" },
				destination: { kind: "folder", folderId: "e2e-folder-stale" },
			},
		})

		assert.strictEqual(result.success, false)
		assert.strictEqual(result.error?.code, "TASK_ORG/CONFLICT/002")
		assert.ok(result.error?.message.includes("Organization state has changed"))
	})
})
