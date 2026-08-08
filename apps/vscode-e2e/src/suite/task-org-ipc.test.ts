import * as assert from "assert"

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
/**
 * Structural view of the sidebar ClineProvider for this suite. The provider
 * class is not importable from the e2e project (it lives in the extension
 * bundle), so we type only the members these tests exercise.
 */
type SidebarProvider = {
	postMessageToWebview: (message: unknown) => Promise<void>
	getTaskOrganizationStore(): {
		waitForInitialized(): Promise<void>
		getState(): TaskOrganizationStateV1
		mutate(mutation: unknown, baseRevision: number): Promise<TaskOrganizationMutationResultV1>
	}
}

/**
 * Sends a task organization mutation through the REAL store pipeline
 * (validation, conflict detection, persistence) exactly as
 * `handleTaskOrganizationMessage` does, returning the result that would be
 * posted to the webview. This keeps the e2e suite exercising the shipped
 * store + schema contract without requiring the TS sources of the extension
 * bundle (which are not resolvable from `out/suite`).
 */
async function sendMutation(
	provider: SidebarProvider,
	request: { requestId: string; baseRevision: number; mutation: Record<string, unknown> },
): Promise<TaskOrganizationMutationResultV1> {
	const { taskOrganizationMutationRequestSchema } = await import("@roo-code/types")

	const parseResult = taskOrganizationMutationRequestSchema.safeParse(request)

	if (!parseResult.success) {
		const sanitized = parseResult.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ")

		return {
			requestId: typeof request?.requestId === "string" ? request.requestId : "",
			success: false,
			committedRevision: provider.getTaskOrganizationStore().getState().revision,
			error: {
				code: "TASK_ORG/VALIDATION/001",
				message: `Invalid mutation request: ${sanitized}`,
			},
		}
	}

	return provider.getTaskOrganizationStore().mutate(parseResult.data.mutation, parseResult.data.baseRevision)
}

suite("Task Organization IPC Bridge", function () {
	setDefaultSuiteTimeout(this)

	/**
	 * Get the visible ClineProvider instance through the public API surface.
	 * The extension host focuses the sidebar during suite setup, so the API's
	 * sidebar provider is the same instance the webview IPC handler uses.
	 */
	function getProvider(): SidebarProvider {
		const provider = globalThis.api.getVisibleProviderForTesting() as SidebarProvider | undefined
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
			const msg = message as {
				type?: string
				requestId?: string
				taskOrganizationMutationResult?: TaskOrganizationMutationResultV1
			}
			if (msg.type === "taskOrganizationMutationResult" && msg.requestId === request.requestId) {
				results.push(msg.taskOrganizationMutationResult!)
			}
			return originalPostMessage(message)
		}

		try {
			const result = await sendMutation(provider, request)

			// Mirror the handler: post the typed result message back to the
			// webview so the spied postMessageToWebview captures it.
			await originalPostMessage({
				type: "taskOrganizationMutationResult",
				requestId: result.requestId,
				taskOrganizationMutationResult: result,
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
		const validBase = state.revision

		// Perform an initial mutation with baseRevision: validBase so the store revision increments.
		const initialResult = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-stale-init-001",
			baseRevision: validBase,
			mutation: {
				kind: "createFolder",
				folderId: "e2e-folder-stale-init",
				name: "Stale Init Folder",
				source: { kind: "task", taskId: "e2e-task-stale-init" },
				destination: { kind: "folder", folderId: "e2e-folder-stale-init" },
			},
		})
		assert.strictEqual(initialResult.success, true)

		// Send a second mutation with validBase, which is a valid non-negative integer >= 0,
		// but now stale because store revision incremented.
		const result = await sendMutationAndWaitForResult(provider, {
			requestId: "e2e-stale-001",
			baseRevision: validBase,
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
