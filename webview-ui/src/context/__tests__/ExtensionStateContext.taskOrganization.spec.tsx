import { render, screen, act, waitFor } from "@/utils/test-utils"
import React from "react"

import {
	type TaskOrganizationStateV1,
	type TaskOrganizationMutationResultV1,
	createEmptyTaskOrganizationState,
} from "@roo-code/types"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const postMessageMock = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

const TaskOrganizationTestComponent = () => {
	const { taskOrganization, mutateTaskOrganization } = useExtensionState()

	return (
		<div>
			<div data-testid="task-organization">{JSON.stringify(taskOrganization)}</div>
			<button
				data-testid="mutate-button"
				onClick={async () => {
					const result = await mutateTaskOrganization({
						kind: "setPinned",
						target: { kind: "task", taskId: "task-1" },
						pinned: true,
					})
					;(window as any).__lastMutationResult__ = result
				}}>
				Mutate
			</button>
		</div>
	)
}

const makeSnapshot = (revision: number): TaskOrganizationStateV1 => ({
	schemaVersion: 1,
	revision,
	folders: [
		{
			folderId: "folder-1",
			name: "Folder A",
			taskIds: ["task-1"],
			createdAt: 1000,
			updatedAt: 1000,
		},
	],
	pins: [
		{
			target: { kind: "task", taskId: "task-1" },
			pinnedAt: 2000,
		},
	],
	updatedAt: 3000,
})

describe("ExtensionStateContext task organization", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
		;(window as any).__lastMutationResult__ = undefined
	})

	it("initializes with an empty task organization state", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		const parsed = JSON.parse(screen.getByTestId("task-organization").textContent!)
		const expected = createEmptyTaskOrganizationState()
		expect(parsed.schemaVersion).toBe(expected.schemaVersion)
		expect(parsed.revision).toBe(expected.revision)
		expect(parsed.folders).toEqual(expected.folders)
		expect(parsed.pins).toEqual(expected.pins)
		expect(typeof parsed.updatedAt).toBe("number")
	})

	it("hydrates task organization from a state message", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		const snapshot = makeSnapshot(1)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: snapshot } },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("task-organization").textContent!)).toEqual(snapshot)
	})

	it("applies a newer taskOrganization revision in a full state message", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: makeSnapshot(1) } },
				}),
			)
		})

		const next = makeSnapshot(2)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: next } },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("task-organization").textContent!)).toEqual(next)
	})

	it("ignores a stale taskOrganization revision in a full state message", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: makeSnapshot(2) } },
				}),
			)
		})

		// A full-state push assembled before the revision-2 commit arrives late
		// and must not regress the webview to the older revision.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: makeSnapshot(1) } },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("task-organization").textContent!)).toEqual(makeSnapshot(2))
	})

	it("updates task organization on taskOrganizationUpdated with a greater revision", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: makeSnapshot(1) } },
				}),
			)
		})

		const next = makeSnapshot(2)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationUpdated", taskOrganization: next },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("task-organization").textContent!)).toEqual(next)
	})

	it("ignores taskOrganizationUpdated with a stale revision", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { taskOrganization: makeSnapshot(2) } },
				}),
			)
		})

		const stale = makeSnapshot(1)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationUpdated", taskOrganization: stale },
				}),
			)
		})

		expect(JSON.parse(screen.getByTestId("task-organization").textContent!)).toEqual(makeSnapshot(2))
	})

	it("posts a taskOrganizationMutation and resolves the result by requestId", async () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("mutate-button").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "taskOrganizationMutation",
					taskOrganizationMutation: expect.objectContaining({
						baseRevision: 0,
						mutation: {
							kind: "setPinned",
							target: { kind: "task", taskId: "task-1" },
							pinned: true,
						},
					}),
				}),
			)
		})

		const requestId = postMessageMock.mock.calls.find((call) => call[0].type === "taskOrganizationMutation")?.[0]
			.taskOrganizationMutation.requestId

		const result: TaskOrganizationMutationResultV1 = {
			requestId,
			success: true,
			committedRevision: 1,
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationMutationResult", taskOrganizationMutationResult: result },
				}),
			)
		})

		await waitFor(() => {
			expect((window as any).__lastMutationResult__).toEqual(result)
		})
	})

	it("keeps pending mutation resolvers until a matching result arrives", async () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("mutate-button").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "taskOrganizationMutation" }))
		})

		const requestId = postMessageMock.mock.calls.find((call) => call[0].type === "taskOrganizationMutation")?.[0]
			.taskOrganizationMutation.requestId

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "taskOrganizationMutationResult",
						taskOrganizationMutationResult: {
							requestId: "other-request",
							success: true,
							committedRevision: 99,
						},
					},
				}),
			)
		})

		// The pending resolver should still be waiting.
		expect((window as any).__lastMutationResult__).toBeUndefined()

		const result: TaskOrganizationMutationResultV1 = {
			requestId,
			success: false,
			committedRevision: 0,
			error: { code: "TASK_ORG/PIN_LIMIT/003", message: "Maximum three pins allowed." },
		}

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationMutationResult", taskOrganizationMutationResult: result },
				}),
			)
		})

		await waitFor(() => {
			expect((window as any).__lastMutationResult__).toEqual(result)
		})
	})

	it("handles taskOrganizationUpdated with null/undefined snapshot gracefully", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationUpdated", taskOrganization: undefined },
				}),
			)
		})

		const expected = createEmptyTaskOrganizationState()
		const parsed = JSON.parse(screen.getByTestId("task-organization").textContent!)
		expect(parsed.schemaVersion).toBe(expected.schemaVersion)
	})

	it("handles taskOrganizationMutationResult with null/undefined result gracefully", () => {
		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationTestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOrganizationMutationResult", taskOrganizationMutationResult: undefined },
				}),
			)
		})

		expect((window as any).__lastMutationResult__).toBeUndefined()
	})
})
