import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import type { TaskOrganizationStateV1 } from "@roo-code/types"

import { UNFILED_DROP_ZONE_ID } from "../useTaskOrganizationDnd"
import { TaskOrganizationDndSurface } from "../TaskOrganizationDndSurface"
import { TaskOrganizationInteractionProvider } from "../TaskOrganizationInteractionContext"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			if (!params) return key
			return Object.entries(params).reduce(
				(acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v)),
				key,
			)
		},
	}),
}))

// The DnD controller is mocked so the surface's orchestration (draft state,
// dialog, mutation routing) can be tested without a real pointer session.
vi.mock("../useTaskOrganizationDnd", async () => {
	const actual = await vi.importActual<typeof import("../useTaskOrganizationDnd")>("../useTaskOrganizationDnd")
	return {
		...actual,
		useTaskOrganizationDnd: vi.fn(),
	}
})

// Render the DragOverlay inline (no portal) so overlay content is assertable
// in jsdom. The surface's overlay *content* is what we test, not the portal.
vi.mock("@dnd-kit/core", async () => {
	const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
	return {
		...actual,
		DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	}
})

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTaskOrganizationDnd } from "../useTaskOrganizationDnd"

const mockUseExtensionState = useExtensionState as any
const mockUseTaskOrganizationDnd = useTaskOrganizationDnd as any

function createEmptyOrganizationState(): TaskOrganizationStateV1 {
	return {
		schemaVersion: 1,
		revision: 0,
		folders: [],
		pins: [],
		updatedAt: 0,
	}
}

function createSuccessResult() {
	return {
		requestId: "",
		success: true,
		committedRevision: 1,
	}
}

interface CapturedOptions {
	onRequestCreateFolder: (source: any, destination: any) => void
	onRequestMoveToFolder: (source: any, folderId: string) => void
	onRequestRemoveFromFolder: (source: any, folderId: string) => void
	onCancel?: () => void
}

/**
 * Captures the options the surface passes to useTaskOrganizationDnd and
 * returns a controllable activeDrag state.
 */
function installDndCapture(initial: { activeDrag?: any } = {}) {
	let capturedOptions: CapturedOptions | null = null
	let activeDrag = initial.activeDrag ?? null

	mockUseTaskOrganizationDnd.mockImplementation((options: CapturedOptions) => {
		capturedOptions = options
		return {
			sensors: [],
			activeDrag,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		}
	})

	return {
		getOptions(): CapturedOptions {
			if (!capturedOptions) throw new Error("useTaskOrganizationDnd not invoked")
			return capturedOptions
		},
		setActiveDrag(next: any) {
			activeDrag = next
		},
	}
}

import type { TaskOrganizationDndSurfaceRenderState } from "../TaskOrganizationDndSurface"

function renderSurface(
	ui: React.ReactNode | ((state: TaskOrganizationDndSurfaceRenderState) => React.ReactNode),
	options: {
		enabled?: boolean
		resolveDragLabel?: (drag: any) => React.ReactNode
		organization?: TaskOrganizationStateV1
		mutate?: any
	} = {},
) {
	const mutate = options.mutate ?? vi.fn().mockResolvedValue(createSuccessResult())
	mockUseExtensionState.mockReturnValue({
		taskOrganization: options.organization ?? createEmptyOrganizationState(),
		mutateTaskOrganization: mutate,
	})

	const view = render(
		<TaskOrganizationInteractionProvider>
			<TaskOrganizationDndSurface
				enabled={options.enabled ?? true}
				resolveDragLabel={options.resolveDragLabel ?? (() => "label")}>
				{ui}
			</TaskOrganizationDndSurface>
		</TaskOrganizationInteractionProvider>,
	)
	return { ...view, mutate }
}

describe("TaskOrganizationDndSurface", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders children and wires DnD controller options", () => {
		installDndCapture()
		renderSurface(<div data-testid="child-content">hello</div>)

		expect(screen.getByTestId("child-content")).toBeInTheDocument()
		// Controller invoked with request callbacks.
		expect(mockUseTaskOrganizationDnd).toHaveBeenCalled()
		const options = mockUseTaskOrganizationDnd.mock.calls[0][0]
		expect(typeof options.onRequestCreateFolder).toBe("function")
		expect(typeof options.onRequestMoveToFolder).toBe("function")
		expect(typeof options.onRequestRemoveFromFolder).toBe("function")
	})

	it("opens the folder-name dialog on a create-folder request and posts createFolder on confirm", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		renderSurface(<div />, { mutate: mutateSpy })

		const options = capture.getOptions()
		options.onRequestCreateFolder({ kind: "task", taskId: "t1" }, { kind: "task", taskId: "t2" })

		const input = await screen.findByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "New Folder" } })
		fireEvent.keyDown(input, { key: "Enter" })

		await waitFor(() => {
			expect(mutateSpy).toHaveBeenCalled()
		})
		const calls = mutateSpy.mock.calls.filter((c: any[]) => c[0]?.kind === "createFolder")
		expect(calls).toHaveLength(1)
		expect(calls[0][0].name).toBe("New Folder")
		expect(calls[0][0].source).toEqual({ kind: "task", taskId: "t1" })
		expect(calls[0][0].destination).toEqual({ kind: "task", taskId: "t2" })
	})

	it("posts nothing when the folder-name dialog is cancelled", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		renderSurface(<div />, { mutate: mutateSpy })

		capture.getOptions().onRequestCreateFolder({ kind: "task", taskId: "t1" }, { kind: "task", taskId: "t2" })

		const cancelButton = await screen.findByTestId("folder-name-cancel")
		fireEvent.click(cancelButton)

		await waitFor(() => {
			expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		})
		expect(mutateSpy).not.toHaveBeenCalled()
	})

	it("cancels a pending draft when disabled", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		const { rerender } = render(
			<TaskOrganizationInteractionProvider>
				<TaskOrganizationDndSurface enabled resolveDragLabel={() => "label"}>
					<div />
				</TaskOrganizationDndSurface>
			</TaskOrganizationInteractionProvider>,
		)
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: mutateSpy,
		})

		capture.getOptions().onRequestCreateFolder({ kind: "task", taskId: "t1" }, { kind: "task", taskId: "t2" })
		await screen.findByTestId("folder-name-input")

		rerender(
			<TaskOrganizationInteractionProvider>
				<TaskOrganizationDndSurface enabled={false} resolveDragLabel={() => "label"}>
					<div />
				</TaskOrganizationDndSurface>
			</TaskOrganizationInteractionProvider>,
		)

		await waitFor(() => {
			expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		})
		expect(mutateSpy).not.toHaveBeenCalled()
	})

	it("cancels a pending draft when the organization revision changes", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())

		const makeProps = (revision: number) => ({
			taskOrganization: { ...createEmptyOrganizationState(), revision },
			mutateTaskOrganization: mutateSpy,
		})

		mockUseExtensionState.mockReturnValue(makeProps(0))
		const { rerender } = render(
			<TaskOrganizationInteractionProvider>
				<TaskOrganizationDndSurface enabled resolveDragLabel={() => "label"}>
					<div />
				</TaskOrganizationDndSurface>
			</TaskOrganizationInteractionProvider>,
		)

		capture.getOptions().onRequestCreateFolder({ kind: "task", taskId: "t1" }, { kind: "task", taskId: "t2" })
		await screen.findByTestId("folder-name-input")

		mockUseExtensionState.mockReturnValue(makeProps(1))
		rerender(
			<TaskOrganizationInteractionProvider>
				<TaskOrganizationDndSurface enabled resolveDragLabel={() => "label"}>
					<div />
				</TaskOrganizationDndSurface>
			</TaskOrganizationInteractionProvider>,
		)

		await waitFor(() => {
			expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		})
		expect(mutateSpy).not.toHaveBeenCalled()
	})

	it("routes move-to-folder requests to the moveToFolder mutation", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		renderSurface(<div />, { mutate: mutateSpy })

		capture.getOptions().onRequestMoveToFolder({ kind: "task", taskId: "t1" }, "folder-9")

		await waitFor(() => {
			expect(mutateSpy).toHaveBeenCalled()
		})
		const call = mutateSpy.mock.calls[0][0]
		expect(call.kind).toBe("moveToFolder")
		expect(call.folderId).toBe("folder-9")
		expect(call.source).toEqual({ kind: "task", taskId: "t1" })
	})

	it("routes remove-from-folder requests to the removeFromFolder mutation", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		renderSurface(<div />, { mutate: mutateSpy })

		capture.getOptions().onRequestRemoveFromFolder({ kind: "task", taskId: "t1" }, "folder-3")

		await waitFor(() => {
			expect(mutateSpy).toHaveBeenCalled()
		})
		const call = mutateSpy.mock.calls[0][0]
		expect(call.kind).toBe("removeFromFolder")
		expect(call.folderId).toBe("folder-3")
		expect(call.source).toEqual({ kind: "task", taskId: "t1" })
	})

	it("suppresses mutation routing while disabled", async () => {
		const capture = installDndCapture()
		const mutateSpy = vi.fn().mockResolvedValue(createSuccessResult())
		renderSurface(<div />, { enabled: false, mutate: mutateSpy })

		const options = capture.getOptions()
		options.onRequestCreateFolder({ kind: "task", taskId: "t1" }, { kind: "task", taskId: "t2" })
		options.onRequestMoveToFolder({ kind: "task", taskId: "t1" }, "folder-1")
		options.onRequestRemoveFromFolder({ kind: "task", taskId: "t1" }, "folder-1")

		expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		expect(mutateSpy).not.toHaveBeenCalled()
	})

	it("exposes isFolderMemberDragActive to children via render prop", () => {
		const capture = installDndCapture({
			activeDrag: {
				id: "drag-1",
				data: { kind: "task", target: { kind: "task", taskId: "t1" }, folderId: "folder-1" },
			},
		})

		renderSurface((state) => (
			<div data-testid="folder-member-drag">{state.isFolderMemberDragActive ? "active" : "inactive"}</div>
		))
		expect(capture).toBeTruthy()
		expect(screen.getByTestId("folder-member-drag").textContent).toBe("active")
	})

	it("reports isFolderMemberDragActive=false for unfiled drags", () => {
		installDndCapture({
			activeDrag: {
				id: "drag-1",
				data: { kind: "task", target: { kind: "task", taskId: "t1" } },
			},
		})

		renderSurface((state) => (
			<div data-testid="folder-member-drag">{state.isFolderMemberDragActive ? "active" : "inactive"}</div>
		))
		expect(screen.getByTestId("folder-member-drag").textContent).toBe("inactive")
	})

	it("renders the drag overlay with the resolved label while a drag is active", () => {
		installDndCapture({
			activeDrag: {
				id: "drag-1",
				data: { kind: "task", target: { kind: "task", taskId: "t1" } },
			},
		})

		renderSurface(<div />, { resolveDragLabel: () => "Task t1 label" })
		expect(screen.getByTestId("drag-overlay").textContent).toBe("Task t1 label")
	})

	it("renders no overlay content when there is no active drag", () => {
		installDndCapture()
		renderSurface(<div />)
		expect(screen.queryByTestId("drag-overlay")).not.toBeInTheDocument()
	})

	it("renders empty string in drag overlay when resolveDragLabel returns null", () => {
		installDndCapture({
			activeDrag: {
				id: "drag-1",
				data: { kind: "task", target: { kind: "task", taskId: "t1" } },
			},
		})

		renderSurface(<div />, { resolveDragLabel: () => null })
		expect(screen.getByTestId("drag-overlay").textContent).toBe("")
	})
})
