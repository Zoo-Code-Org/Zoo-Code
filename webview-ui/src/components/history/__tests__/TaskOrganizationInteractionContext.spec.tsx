import { render, screen, act, waitFor } from "@/utils/test-utils"
import React from "react"

import type { TaskOrganizationMutationResultV1, TaskOrganizationStateV1 } from "@roo-code/types"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { TaskOrganizationInteractionProvider, useTaskOrganization } from "../TaskOrganizationInteractionContext"

const postMessageMock = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

type ActionKind = "createFromSelection" | "deleteFolders" | "createFolder" | "deleteFolder"

const InteractionHarness = () => {
	const { createFolderFromSelection, deleteFolders, createFolder, deleteFolder, organization } = useTaskOrganization()

	const run = async (kind: ActionKind) => {
		let result: TaskOrganizationMutationResultV1 | undefined
		if (kind === "createFromSelection") {
			result = await createFolderFromSelection("My Folder", [
				{ kind: "task", taskId: "task-a" },
				{ kind: "autoGroup", rootTaskId: "root-b" },
				{ kind: "folder", folderId: "folder-x" },
			])
		} else if (kind === "deleteFolders") {
			result = await deleteFolders(["folder-1", "folder-2"])
		} else if (kind === "createFolder") {
			result = await createFolder("Pair", { kind: "task", taskId: "task-1" }, { kind: "task", taskId: "task-2" })
		} else {
			result = await deleteFolder("folder-9")
		}
		;(window as any).__lastResult__ = result
	}

	return (
		<div>
			<div data-testid="org-state">{JSON.stringify(organization)}</div>
			<button data-testid="btn-create-selection" onClick={() => run("createFromSelection")} />
			<button data-testid="btn-delete-folders" onClick={() => run("deleteFolders")} />
			<button data-testid="btn-create-folder" onClick={() => run("createFolder")} />
			<button data-testid="btn-delete-folder" onClick={() => run("deleteFolder")} />
		</div>
	)
}

const renderProviders = () =>
	render(
		<ExtensionStateContextProvider>
			<TaskOrganizationInteractionProvider>
				<InteractionHarness />
			</TaskOrganizationInteractionProvider>
		</ExtensionStateContextProvider>,
	)

const snapshot = (revision: number): TaskOrganizationStateV1 => ({
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
	pins: [],
	updatedAt: 2000,
})

const hydrateState = (state: TaskOrganizationStateV1) => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "state", state: { taskOrganization: state } },
			}),
		)
	})
}

const latestMutationCall = () =>
	postMessageMock.mock.calls
		.map((call) => call[0])
		.filter((msg) => msg.type === "taskOrganizationMutation")
		.at(-1)

const respondToRequest = (requestId: string, result: Omit<TaskOrganizationMutationResultV1, "requestId">) => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "taskOrganizationMutationResult",
					taskOrganizationMutationResult: { requestId, ...result },
				},
			}),
		)
	})
}

describe("TaskOrganizationInteractionContext", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
		;(window as any).__lastResult__ = undefined
	})

	it("dispatches one createFolderFromSelection mutation with a generated folderId and exact targets", async () => {
		renderProviders()
		hydrateState(snapshot(5))

		act(() => {
			screen.getByTestId("btn-create-selection").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "taskOrganizationMutation" }))
		})

		const msg = latestMutationCall()
		expect(msg.taskOrganizationMutation.baseRevision).toBe(5)
		const mutation = msg.taskOrganizationMutation.mutation
		expect(mutation.kind).toBe("createFolderFromSelection")
		expect(mutation.name).toBe("My Folder")
		expect(mutation.targets).toEqual([
			{ kind: "task", taskId: "task-a" },
			{ kind: "autoGroup", rootTaskId: "root-b" },
			{ kind: "folder", folderId: "folder-x" },
		])
		// Folder ID generated in the interaction layer, consistent with createFolder's scheme.
		expect(mutation.folderId).toMatch(/^folder-\d+-[a-z0-9]+$/)
		// Exactly one mutation post for one helper invocation.
		expect(postMessageMock.mock.calls.filter((c) => c[0].type === "taskOrganizationMutation")).toHaveLength(1)

		respondToRequest(msg.taskOrganizationMutation.requestId, { success: true, committedRevision: 6 })

		await waitFor(() => {
			expect((window as any).__lastResult__).toEqual({
				requestId: msg.taskOrganizationMutation.requestId,
				success: true,
				committedRevision: 6,
			})
		})

		// No optimistic state change: organization state only updates on host messages.
		expect(JSON.parse(screen.getByTestId("org-state").textContent!)).toEqual(snapshot(5))
	})

	it("dispatches one deleteFolders mutation with the exact folderIds", async () => {
		renderProviders()
		hydrateState(snapshot(3))

		act(() => {
			screen.getByTestId("btn-delete-folders").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "taskOrganizationMutation" }))
		})

		const msg = latestMutationCall()
		expect(msg.taskOrganizationMutation.baseRevision).toBe(3)
		expect(msg.taskOrganizationMutation.mutation).toEqual({
			kind: "deleteFolders",
			folderIds: ["folder-1", "folder-2"],
		})
		expect(postMessageMock.mock.calls.filter((c) => c[0].type === "taskOrganizationMutation")).toHaveLength(1)

		respondToRequest(msg.taskOrganizationMutation.requestId, { success: true, committedRevision: 4 })

		await waitFor(() => {
			expect((window as any).__lastResult__).toEqual({
				requestId: msg.taskOrganizationMutation.requestId,
				success: true,
				committedRevision: 4,
			})
		})
	})

	it("returns host failures unchanged without throwing", async () => {
		renderProviders()
		hydrateState(snapshot(2))

		act(() => {
			screen.getByTestId("btn-delete-folders").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "taskOrganizationMutation" }))
		})

		const msg = latestMutationCall()
		const failure = {
			success: false,
			committedRevision: 2,
			error: { code: "TASK_ORG/NOT_FOUND/004", message: "Folder not found." },
		} as const
		respondToRequest(msg.taskOrganizationMutation.requestId, failure)

		await waitFor(() => {
			expect((window as any).__lastResult__).toEqual({
				requestId: msg.taskOrganizationMutation.requestId,
				...failure,
			})
		})

		// State untouched by the failed mutation.
		expect(JSON.parse(screen.getByTestId("org-state").textContent!)).toEqual(snapshot(2))
	})

	it("keeps existing createFolder/deleteFolder payload shape and folderId generation scheme", async () => {
		renderProviders()
		hydrateState(snapshot(1))

		act(() => {
			screen.getByTestId("btn-create-folder").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "taskOrganizationMutation" }))
		})

		let msg = latestMutationCall()
		expect(msg.taskOrganizationMutation.mutation.kind).toBe("createFolder")
		expect(msg.taskOrganizationMutation.mutation.folderId).toMatch(/^folder-\d+-[a-z0-9]+$/)

		respondToRequest(msg.taskOrganizationMutation.requestId, { success: true, committedRevision: 2 })

		await waitFor(() => {
			expect((window as any).__lastResult__).toBeDefined()
		})

		act(() => {
			screen.getByTestId("btn-delete-folder").click()
		})

		await waitFor(() => {
			expect(postMessageMock.mock.calls.filter((c) => c[0].type === "taskOrganizationMutation")).toHaveLength(2)
		})

		msg = latestMutationCall()
		expect(msg.taskOrganizationMutation.mutation).toEqual({ kind: "deleteFolder", folderId: "folder-9" })
	})

	it("returns error code TASK_ORG/PIN_LIMIT/003 when attempting to pin beyond maximum limit", async () => {
		const TestPinLimit = () => {
			const { togglePin } = useTaskOrganization()
			return (
				<button
					data-testid="btn-pin"
					onClick={async () => {
						const res = await togglePin({ kind: "task", taskId: "new-task" })
						;(window as any).__pinLimitResult__ = res
					}}
				/>
			)
		}

		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationInteractionProvider>
					<TestPinLimit />
				</TaskOrganizationInteractionProvider>
			</ExtensionStateContextProvider>,
		)

		hydrateState({
			schemaVersion: 1,
			revision: 5,
			folders: [],
			pins: [
				{ target: { kind: "task", taskId: "p1" }, pinnedAt: 1 },
				{ target: { kind: "task", taskId: "p2" }, pinnedAt: 2 },
				{ target: { kind: "task", taskId: "p3" }, pinnedAt: 3 },
			],
			updatedAt: 100,
		})

		act(() => {
			screen.getByTestId("btn-pin").click()
		})

		await waitFor(() => {
			expect((window as any).__pinLimitResult__).toEqual({
				requestId: "",
				success: false,
				committedRevision: 5,
				error: {
					code: "TASK_ORG/PIN_LIMIT/003",
					message: "TASK_ORG/PIN_LIMIT/003",
				},
			})
		})
	})

	it("sends renameFolder mutation when renameFolder is called", async () => {
		const TestRename = () => {
			const { renameFolder } = useTaskOrganization()
			return (
				<button
					data-testid="btn-rename"
					onClick={() => {
						void renameFolder("folder-1", "New Folder Name")
					}}
				/>
			)
		}

		render(
			<ExtensionStateContextProvider>
				<TaskOrganizationInteractionProvider>
					<TestRename />
				</TaskOrganizationInteractionProvider>
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("btn-rename").click()
		})

		await waitFor(() => {
			expect(postMessageMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "taskOrganizationMutation",
					taskOrganizationMutation: expect.objectContaining({
						mutation: { kind: "renameFolder", folderId: "folder-1", name: "New Folder Name" },
					}),
				}),
			)
		})
	})

	it("throws error when useTaskOrganization is used outside TaskOrganizationInteractionProvider", () => {
		const BadComponent = () => {
			useTaskOrganization()
			return null
		}

		expect(() => render(<BadComponent />)).toThrow(
			"useTaskOrganization must be used within a TaskOrganizationInteractionProvider",
		)
	})
})
