import { render, screen, act, waitFor } from "@/utils/test-utils"
import React from "react"

import type { TaskOrganizationMutationResultV1, TaskOrganizationStateV1 } from "@roo-code/types"
import { MAX_PINNED_TARGETS } from "@roo-code/types"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { TaskOrganizationInteractionProvider, useTaskOrganization } from "../TaskOrganizationInteractionContext"

const postMessageMock = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

describe("TaskOrganizationInteractionContext edge cases", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
		;(window as any).__lastResult__ = undefined
	})

	describe("useTaskOrganization error", () => {
		it("throws when used outside provider", () => {
			const OrphanComponent = () => {
				useTaskOrganization()
				return <div />
			}

			expect(() => render(<OrphanComponent />)).toThrow(
				"useTaskOrganization must be used within a TaskOrganizationInteractionProvider",
			)
		})
	})

	describe("togglePin at limit", () => {
		const stateWithMaxPins: TaskOrganizationStateV1 = {
			schemaVersion: 1,
			revision: 3,
			folders: [],
			pins: Array.from({ length: MAX_PINNED_TARGETS }, (_, i) => ({
				target: { kind: "task" as const, taskId: `task-${i}` },
				pinnedAt: 1000 + i,
			})),
			updatedAt: 2000,
		}

		const TogglePinHarness = () => {
			const { togglePin, canPin, isPinned } = useTaskOrganization()
			return (
				<div>
					<div data-testid="can-pin">{String(canPin)}</div>
					<div data-testid="is-pinned-new">{String(isPinned({ kind: "task", taskId: "task-new" }))}</div>
					<button
						data-testid="toggle-new"
						onClick={async () => {
							const result = await togglePin({ kind: "task", taskId: "task-new" })
							;(window as any).__lastResult__ = result
						}}
					/>
					<button
						data-testid="toggle-existing"
						onClick={async () => {
							const result = await togglePin({ kind: "task", taskId: "task-0" })
							;(window as any).__lastResult__ = result
						}}
					/>
				</div>
			)
		}

		it("returns local validation failure when pin limit is reached", async () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<TogglePinHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			// Hydrate state with max pins
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { taskOrganization: stateWithMaxPins } },
					}),
				)
			})

			expect(screen.getByTestId("can-pin").textContent).toBe("false")
			expect(screen.getByTestId("is-pinned-new").textContent).toBe("false")

			act(() => {
				screen.getByTestId("toggle-new").click()
			})

			await waitFor(() => {
				expect((window as any).__lastResult__).toEqual({
					requestId: "",
					success: false,
					committedRevision: 3,
					error: {
						code: "TASK_ORG/PIN_LIMIT/003",
						message: "TASK_ORG/PIN_LIMIT/003",
					},
				})
			})

			// No postMessage should have been sent for the pin attempt
			expect(postMessageMock.mock.calls.filter((c) => c[0].type === "taskOrganizationMutation")).toHaveLength(0)
		})

		it("allows unpinning when at limit", async () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<TogglePinHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { taskOrganization: stateWithMaxPins } },
					}),
				)
			})

			// Unpin an existing pinned task
			act(() => {
				screen.getByTestId("toggle-existing").click()
			})

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "taskOrganizationMutation",
						taskOrganizationMutation: expect.objectContaining({
							mutation: {
								kind: "setPinned",
								target: { kind: "task", taskId: "task-0" },
								pinned: false,
							},
						}),
					}),
				)
			})
		})
	})

	describe("renameFolder", () => {
		const RenameHarness = () => {
			const { renameFolder } = useTaskOrganization()
			return (
				<button
					data-testid="rename-btn"
					onClick={async () => {
						const result = await renameFolder("folder-1", "New Name")
						;(window as any).__lastResult__ = result
					}}
				/>
			)
		}

		it("dispatches renameFolder mutation", async () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<RenameHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			act(() => {
				screen.getByTestId("rename-btn").click()
			})

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "taskOrganizationMutation",
						taskOrganizationMutation: expect.objectContaining({
							mutation: {
								kind: "renameFolder",
								folderId: "folder-1",
								name: "New Name",
							},
						}),
					}),
				)
			})
		})
	})

	describe("isPinned and canPin", () => {
		const stateWithPins: TaskOrganizationStateV1 = {
			schemaVersion: 1,
			revision: 1,
			folders: [],
			pins: [
				{ target: { kind: "task", taskId: "task-a" }, pinnedAt: 100 },
				{ target: { kind: "autoGroup", rootTaskId: "root-b" }, pinnedAt: 200 },
				{ target: { kind: "folder", folderId: "folder-c" }, pinnedAt: 300 },
			],
			updatedAt: 400,
		}

		const PinCheckHarness = () => {
			const { isPinned, canPin, organization } = useTaskOrganization()
			return (
				<div>
					<div data-testid="pin-count">{organization.pins.length}</div>
					<div data-testid="can-pin">{String(canPin)}</div>
					<div data-testid="is-pinned-task">{String(isPinned({ kind: "task", taskId: "task-a" }))}</div>
					<div data-testid="is-pinned-group">
						{String(isPinned({ kind: "autoGroup", rootTaskId: "root-b" }))}
					</div>
					<div data-testid="is-pinned-folder">
						{String(isPinned({ kind: "folder", folderId: "folder-c" }))}
					</div>
					<div data-testid="is-pinned-unknown">
						{String(isPinned({ kind: "task", taskId: "task-unknown" }))}
					</div>
				</div>
			)
		}

		it("correctly identifies pinned targets of all kinds", () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<PinCheckHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { taskOrganization: stateWithPins } },
					}),
				)
			})

			expect(screen.getByTestId("pin-count").textContent).toBe("3")
			expect(screen.getByTestId("is-pinned-task").textContent).toBe("true")
			expect(screen.getByTestId("is-pinned-group").textContent).toBe("true")
			expect(screen.getByTestId("is-pinned-folder").textContent).toBe("true")
			expect(screen.getByTestId("is-pinned-unknown").textContent).toBe("false")
		})

		it("canPin is true when below limit", () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<PinCheckHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			// With 3 pins (assuming MAX_PINNED_TARGETS > 3)
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { taskOrganization: stateWithPins } },
					}),
				)
			})

			if (MAX_PINNED_TARGETS > 3) {
				expect(screen.getByTestId("can-pin").textContent).toBe("true")
			}
		})
	})

	describe("default organization state", () => {
		it("uses default empty state when taskOrganization is undefined", () => {
			const OrgDisplay = () => {
				const { organization } = useTaskOrganization()
				return <div data-testid="org">{JSON.stringify(organization)}</div>
			}

			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<OrgDisplay />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			const org = JSON.parse(screen.getByTestId("org").textContent!)
			expect(org.schemaVersion).toBe(1)
			expect(org.revision).toBe(0)
			expect(org.folders).toEqual([])
			expect(org.pins).toEqual([])
		})
	})

	describe("moveToFolder and removeFromFolder", () => {
		const MoveHarness = () => {
			const { moveToFolder, removeFromFolder } = useTaskOrganization()
			return (
				<div>
					<button
						data-testid="move-btn"
						onClick={async () => {
							const result = await moveToFolder({ kind: "task", taskId: "task-1" }, "folder-1")
							;(window as any).__lastResult__ = result
						}}
					/>
					<button
						data-testid="remove-btn"
						onClick={async () => {
							const result = await removeFromFolder({ kind: "task", taskId: "task-1" }, "folder-1")
							;(window as any).__lastResult__ = result
						}}
					/>
				</div>
			)
		}

		it("dispatches moveToFolder mutation", async () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<MoveHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			act(() => {
				screen.getByTestId("move-btn").click()
			})

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "taskOrganizationMutation",
						taskOrganizationMutation: expect.objectContaining({
							mutation: {
								kind: "moveToFolder",
								source: { kind: "task", taskId: "task-1" },
								folderId: "folder-1",
							},
						}),
					}),
				)
			})
		})

		it("dispatches removeFromFolder mutation", async () => {
			render(
				<ExtensionStateContextProvider>
					<TaskOrganizationInteractionProvider>
						<MoveHarness />
					</TaskOrganizationInteractionProvider>
				</ExtensionStateContextProvider>,
			)

			act(() => {
				screen.getByTestId("remove-btn").click()
			})

			await waitFor(() => {
				expect(postMessageMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "taskOrganizationMutation",
						taskOrganizationMutation: expect.objectContaining({
							mutation: {
								kind: "removeFromFolder",
								source: { kind: "task", taskId: "task-1" },
								folderId: "folder-1",
							},
						}),
					}),
				)
			})
		})
	})
})
