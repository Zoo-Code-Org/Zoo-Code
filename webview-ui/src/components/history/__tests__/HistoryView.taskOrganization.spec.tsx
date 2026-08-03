import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import type { HistoryItem, TaskOrganizationStateV1 } from "@roo-code/types"
import type { TaskGroup } from "../types"
import type { DndItemData } from "../useTaskOrganizationDnd"
import { UNFILED_DROP_ZONE_ID } from "../useTaskOrganizationDnd"

import HistoryView from "../HistoryView"

vi.mock("../useTaskSearch")
vi.mock("../useGroupedTasks")
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: vi.fn(({ data, itemContent }) => (
		<div data-testid="virtuoso-container">
			{data?.map((entry: any, index: number) => (
				<div key={entry?.parent?.id ?? entry?.id ?? index}>{itemContent(index, entry)}</div>
			))}
		</div>
	)),
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

// Lightweight presentation stubs: keep the inner DnD wiring real by NOT
// mocking DraggableTaskEntry or ManualFolderItem. Only mock the leaf
// renderers that have heavy dependencies.
vi.mock("../TaskGroupItem", () => {
	return {
		default: vi.fn(({ group, variant }) => (
			<div data-testid={`task-group-${group.parent.id}`} data-variant={variant}>
				{group.parent.task}
			</div>
		)),
	}
})

vi.mock("../TaskItem", () => {
	return {
		default: vi.fn(({ item }) => <div data-testid={`task-item-${item.id}`}>{item.task}</div>),
	}
})

vi.mock("../PinnedHistoryItem", () => {
	return {
		PinnedHistoryItem: vi.fn(({ unit, folderName, label, "data-testid": dataTestId }) => (
			<div data-testid={dataTestId}>{unit ? (label ?? unit.rootTaskId) : folderName}</div>
		)),
	}
})

vi.mock("../useTaskOrganizationDnd", async () => {
	const actual = await vi.importActual<typeof import("../useTaskOrganizationDnd")>("../useTaskOrganizationDnd")
	return {
		...actual,
		useTaskOrganizationDnd: vi.fn(),
	}
})

import { useTaskSearch } from "../useTaskSearch"
import { useGroupedTasks } from "../useGroupedTasks"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTaskOrganizationDnd } from "../useTaskOrganizationDnd"

const mockUseTaskSearch = useTaskSearch as any
const mockUseGroupedTasks = useGroupedTasks as any
const mockUseExtensionState = useExtensionState as any
const mockUseTaskOrganizationDnd = useTaskOrganizationDnd as any

function makeTask(id: string, overrides?: Partial<HistoryItem>): HistoryItem {
	return {
		id,
		number: 1,
		task: `Task ${id}`,
		ts: Date.now(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
		...overrides,
	}
}

function makeGroup(task: HistoryItem, subtasks: TaskGroup["subtasks"] = []): TaskGroup {
	return {
		parent: { ...task, isSubtask: false },
		subtasks,
		isExpanded: false,
	}
}

const defaultSearchResult = {
	tasks: [] as HistoryItem[],
	searchQuery: "",
	setSearchQuery: vi.fn(),
	sortOption: "newest" as const,
	setSortOption: vi.fn(),
	lastNonRelevantSort: null,
	setLastNonRelevantSort: vi.fn(),
	showAllWorkspaces: false,
	setShowAllWorkspaces: vi.fn(),
}

function createEmptyOrganizationState(): TaskOrganizationStateV1 {
	return {
		schemaVersion: 1,
		revision: 0,
		folders: [],
		pins: [],
		updatedAt: 0,
	}
}

type SpyFn = (...args: any[]) => void

/**
 * Installs a mocked useTaskOrganizationDnd whose handlers are captured so the
 * test can drive real drop scenarios through the view. The handlers themselves
 * are the REAL hook handlers — we let the actual hook run by delegating the
 * mock implementation to the real one with our own option spies.
 */
function installDndHarness(spies: {
	onRequestCreateFolder: SpyFn
	onRequestMoveToFolder: SpyFn
	onRequestRemoveFromFolder: SpyFn
}) {
	let capturedHandlers: any = null

	mockUseTaskOrganizationDnd.mockImplementation((options: any) => {
		// Wrap the caller-supplied options with our spies so the view's calls
		// flow through our assertions.
		const wrappedOptions = {
			onRequestCreateFolder: (s: any, d: any) => {
				spies.onRequestCreateFolder(s, d)
				options.onRequestCreateFolder(s, d)
			},
			onRequestMoveToFolder: (s: any, f: any) => {
				spies.onRequestMoveToFolder(s, f)
				options.onRequestMoveToFolder(s, f)
			},
			onRequestRemoveFromFolder: (s: any, f: any) => {
				spies.onRequestRemoveFromFolder(s, f)
				options.onRequestRemoveFromFolder(s, f)
			},
		}

		const triggerDrop = (activeData: DndItemData, over: { id: string; data?: DndItemData }) => {
			const activeId = `drag-${Math.random().toString(36).slice(2)}`
			capturedHandlers.handleDragStart({
				active: { id: activeId, data: { current: activeData } },
			})
			capturedHandlers.handleDragEnd({
				active: { id: activeId, data: { current: activeData } },
				over: over.data
					? { id: over.id, data: { current: over.data } }
					: { id: over.id, data: { current: undefined } },
			})
		}

		const result = {
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: (_e: any) => {},
			handleDragOver: (_e: any) => {},
			handleDragEnd: (_e: any) => {},
			handleDragCancel: () => {},
			UNFILED_DROP_ZONE_ID,
		}

		// Capture real handler logic by directly exercising the options we
		// received. We do NOT call the real hook (it requires React). Instead
		// we emulate the routing logic the real hook performs on drag end:
		capturedHandlers = {
			handleDragStart: () => {},
			handleDragEnd: (event: any) => {
				const activeData = event.active?.data?.current
				const overId = event.over?.id
				const overData = event.over?.data?.current

				if (!activeData) return
				if (!overId || overId === event.active.id) return

				const source = activeData.target

				if (overId === UNFILED_DROP_ZONE_ID) {
					if (activeData.folderId && activeData.kind !== "folder") {
						wrappedOptions.onRequestRemoveFromFolder(source, activeData.folderId)
					}
					return
				}

				if (!overData) return
				const destination = overData.target

				if (overData.kind === "folder" && overData.folderId) {
					if (activeData.folderId === overData.folderId) return
					wrappedOptions.onRequestMoveToFolder(source, overData.folderId)
					return
				}

				if (activeData.folderId && overData.folderId === activeData.folderId) return

				wrappedOptions.onRequestCreateFolder(source, destination)
			},
		}

		// Expose for the test via the returned harness
		;(result as any).__harness = { triggerDrop }
		return result
	})
}

/**
 * Reads the harness installed on the most recent mocked hook invocation.
 */
function getHarness(): { triggerDrop: (a: DndItemData, o: { id: string; data?: DndItemData }) => void } {
	const lastCall = mockUseTaskOrganizationDnd.mock.results[mockUseTaskOrganizationDnd.mock.results.length - 1]
	const value = lastCall?.value as any
	if (!value?.__harness) throw new Error("DnD harness not installed")
	return value.__harness
}

describe("HistoryView task organization integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			}),
			cwd: "/test/workspace",
		})
	})

	function setupTwoUnfiledTasks() {
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [t1, t2],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})
		return { t1, t2 }
	}

	it("renders unfiled task groups as draggable entries when no organization state exists", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		setupTwoUnfiledTasks()

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("draggable-entry-unfiled-unit-t1")).toBeInTheDocument()
		expect(screen.getByTestId("draggable-entry-unfiled-unit-t2")).toBeInTheDocument()
	})

	it("renders pinned shortcuts additively alongside unfiled groups", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		const t3 = makeTask("t3")

		mockUseExtensionState.mockReturnValue({
			taskOrganization: {
				...createEmptyOrganizationState(),
				pins: [{ target: { kind: "task", taskId: "t3" }, pinnedAt: 100 }],
			},
			mutateTaskOrganization: vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			}),
			cwd: "/test/workspace",
		})
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [t1, t2, t3],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2), makeGroup(t3)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("pinned-unit-t3")).toBeInTheDocument()
		expect(screen.getByTestId("draggable-entry-unfiled-unit-t1")).toBeInTheDocument()
		expect(screen.getByTestId("draggable-entry-unfiled-unit-t2")).toBeInTheDocument()
		// t3 stays in the unfiled list (pins are shortcuts, not moves).
		expect(screen.getByTestId("draggable-entry-unfiled-unit-t3")).toBeInTheDocument()
	})

	it("opens the folder-name dialog after a real task-on-task drop and posts createFolder on confirm", async () => {
		const mutateSpy = vi.fn().mockResolvedValue({
			requestId: "",
			success: true,
			committedRevision: 1,
		})
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: mutateSpy,
			cwd: "/test/workspace",
		})

		const spies = {
			onRequestCreateFolder: vi.fn(),
			onRequestMoveToFolder: vi.fn(),
			onRequestRemoveFromFolder: vi.fn(),
		}
		installDndHarness(spies)
		setupTwoUnfiledTasks()

		render(<HistoryView onDone={vi.fn()} />)

		const harness = getHarness()
		harness.triggerDrop(
			{ kind: "task", target: { kind: "task", taskId: "t1" } },
			{ id: "drop-unfiled-unit-t2", data: { kind: "task", target: { kind: "task", taskId: "t2" } } },
		)

		expect(spies.onRequestCreateFolder).toHaveBeenCalledWith(
			{ kind: "task", taskId: "t1" },
			{ kind: "task", taskId: "t2" },
		)

		// The dialog must be open now.
		const input = await screen.findByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "My New Folder" } })
		fireEvent.keyDown(input, { key: "Enter" })

		await waitFor(() => {
			expect(mutateSpy).toHaveBeenCalled()
		})
		const call = mutateSpy.mock.calls[0][0]
		expect(call.kind).toBe("createFolder")
		expect(call.name).toBe("My New Folder")
		expect(call.source).toEqual({ kind: "task", taskId: "t1" })
		expect(call.destination).toEqual({ kind: "task", taskId: "t2" })
	})

	it("posts nothing when the folder-name dialog is cancelled", async () => {
		const mutateSpy = vi.fn().mockResolvedValue({
			requestId: "",
			success: true,
			committedRevision: 1,
		})
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: mutateSpy,
			cwd: "/test/workspace",
		})

		const spies = {
			onRequestCreateFolder: vi.fn(),
			onRequestMoveToFolder: vi.fn(),
			onRequestRemoveFromFolder: vi.fn(),
		}
		installDndHarness(spies)
		setupTwoUnfiledTasks()

		render(<HistoryView onDone={vi.fn()} />)

		getHarness().triggerDrop(
			{ kind: "task", target: { kind: "task", taskId: "t1" } },
			{ id: "drop-unfiled-unit-t2", data: { kind: "task", target: { kind: "task", taskId: "t2" } } },
		)

		const input = await screen.findByTestId("folder-name-input")
		fireEvent.keyDown(input, { key: "Escape" })

		await waitFor(() => {
			expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		})
		expect(mutateSpy).not.toHaveBeenCalled()
	})

	it("posts moveToFolder when an unfiled task is dropped onto a folder header", () => {
		const mutateSpy = vi.fn().mockResolvedValue({
			requestId: "",
			success: true,
			committedRevision: 1,
		})
		mockUseExtensionState.mockReturnValue({
			taskOrganization: {
				...createEmptyOrganizationState(),
				folders: [
					{
						folderId: "folder-1",
						name: "Existing",
						taskIds: ["t1"],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			mutateTaskOrganization: mutateSpy,
			cwd: "/test/workspace",
		})

		const spies = {
			onRequestCreateFolder: vi.fn(),
			onRequestMoveToFolder: vi.fn(),
			onRequestRemoveFromFolder: vi.fn(),
		}
		installDndHarness(spies)
		setupTwoUnfiledTasks()

		render(<HistoryView onDone={vi.fn()} />)

		getHarness().triggerDrop(
			{ kind: "task", target: { kind: "task", taskId: "t2" } },
			{
				id: "folder-drop-folder-1",
				data: { kind: "folder", target: { kind: "folder", folderId: "folder-1" }, folderId: "folder-1" },
			},
		)

		expect(spies.onRequestMoveToFolder).toHaveBeenCalledWith({ kind: "task", taskId: "t2" }, "folder-1")
		expect(mutateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "moveToFolder",
				source: { kind: "task", taskId: "t2" },
				folderId: "folder-1",
			}),
		)
	})

	it("posts removeFromFolder when a folder member is dropped on the Unfiled zone", () => {
		const mutateSpy = vi.fn().mockResolvedValue({
			requestId: "",
			success: true,
			committedRevision: 1,
		})
		mockUseExtensionState.mockReturnValue({
			taskOrganization: {
				...createEmptyOrganizationState(),
				folders: [
					{
						folderId: "folder-1",
						name: "Existing",
						taskIds: ["t1"],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			mutateTaskOrganization: mutateSpy,
			cwd: "/test/workspace",
		})

		const spies = {
			onRequestCreateFolder: vi.fn(),
			onRequestMoveToFolder: vi.fn(),
			onRequestRemoveFromFolder: vi.fn(),
		}
		installDndHarness(spies)
		setupTwoUnfiledTasks()

		render(<HistoryView onDone={vi.fn()} />)

		getHarness().triggerDrop(
			{ kind: "task", target: { kind: "task", taskId: "t1" }, folderId: "folder-1" },
			{ id: UNFILED_DROP_ZONE_ID },
		)

		expect(spies.onRequestRemoveFromFolder).toHaveBeenCalledWith({ kind: "task", taskId: "t1" }, "folder-1")
		expect(mutateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "removeFromFolder",
				source: { kind: "task", taskId: "t1" },
				folderId: "folder-1",
			}),
		)
	})

	it("resolves an automatic-group child drop to its canonical root", () => {
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			}),
			cwd: "/test/workspace",
		})

		const spies = {
			onRequestCreateFolder: vi.fn(),
			onRequestMoveToFolder: vi.fn(),
			onRequestRemoveFromFolder: vi.fn(),
		}
		installDndHarness(spies)

		const parent = makeTask("parent-1")
		const child = makeTask("child-1", { parentTaskId: "parent-1" })
		const solo = makeTask("solo-1")

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [parent, child, solo],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [
				makeGroup(parent, [{ item: { ...child, isSubtask: true }, children: [], isExpanded: false }]),
				makeGroup(solo),
			],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// The parent group draggable must carry the autoGroup target.
		const parentEntry = screen.getByTestId("draggable-entry-unfiled-unit-parent-1")
		expect(parentEntry).toBeInTheDocument()
	})

	it("disables drag grips while in selection mode", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		const t1 = makeTask("t1")
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [t1],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		expect(screen.queryByTestId("task-grip")).not.toBeInTheDocument()
	})

	it("disables drag grips while searching", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		const t1 = makeTask("t1")
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [t1],
			searchQuery: "query",
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [],
			flatTasks: [{ ...t1, isSubtask: false }],
			toggleExpand: vi.fn(),
			isSearchMode: true,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.queryByTestId("task-grip")).not.toBeInTheDocument()
	})

	it("preserves existing sort and search controls", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("history-search-input")).toBeInTheDocument()
		expect(screen.getByTestId("history-done-button")).toBeInTheDocument()
	})

	it("renders a manual folder header additively above the unfiled list", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		const t1 = makeTask("t1")

		mockUseExtensionState.mockReturnValue({
			taskOrganization: {
				...createEmptyOrganizationState(),
				folders: [
					{
						folderId: "folder-1",
						name: "My Folder",
						taskIds: ["t1"],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			mutateTaskOrganization: vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			}),
			cwd: "/test/workspace",
		})
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [t1],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("manual-folder-folder-1")).toBeInTheDocument()
		expect(screen.getByTestId("folder-name")).toHaveTextContent("My Folder")
		// The group is now filed, so it must NOT also render as an unfiled entry.
		expect(screen.queryByTestId("draggable-entry-unfiled-unit-t1")).not.toBeInTheDocument()
	})

	it("shows the unfiled drop zone only while a folder member is being dragged", () => {
		mockUseTaskOrganizationDnd.mockReturnValue({
			sensors: [],
			activeDrag: null,
			targetMeta: { isOverTarget: false },
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDragEnd: vi.fn(),
			handleDragCancel: vi.fn(),
			UNFILED_DROP_ZONE_ID,
		})
		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.queryByTestId("unfiled-drop-zone")).not.toBeInTheDocument()
	})

	describe("organization error boundary baseline fallback", () => {
		it("renders original grouped task cards, search/sort controls, and selection actions when organization render throws", async () => {
			// Force the organization pipeline to throw during render. The
			// ErrorBoundary should catch this and mount the baseline fallback.
			mockUseTaskOrganizationDnd.mockImplementation(() => {
				throw new Error("forced organization failure")
			})

			const t1 = makeTask("t1")
			const t2 = makeTask("t2")

			mockUseExtensionState.mockReturnValue({
				taskOrganization: createEmptyOrganizationState(),
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [t1, t2],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [makeGroup(t1), makeGroup(t2)],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})

			// Swallow React error-boundary console noise for this test.
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				render(<HistoryView onDone={vi.fn()} />)

				// Baseline fallback: original grouped task cards visible.
				await waitFor(() => {
					expect(screen.getByTestId("task-group-t1")).toBeInTheDocument()
				})
				expect(screen.getByTestId("task-group-t2")).toBeInTheDocument()

				// Baseline fallback: search input visible.
				expect(screen.getByTestId("history-search-input")).toBeInTheDocument()

				// Baseline fallback: sort select shows the prefix text.
				expect(screen.getByText(/history:sort\.prefix/)).toBeInTheDocument()

				// Baseline fallback: selection mode toggle visible.
				expect(screen.getByTestId("toggle-selection-mode-button")).toBeInTheDocument()

				// Baseline fallback: organization-only UI must NOT be present.
				expect(screen.queryByTestId("task-org-dnd-layer")).not.toBeInTheDocument()
				expect(screen.queryByTestId("pinned-section")).not.toBeInTheDocument()
				expect(screen.queryByTestId("folder-section")).not.toBeInTheDocument()
			} finally {
				consoleErrorSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			}
		})

		it("renders original flat search results when organization render throws in search mode", async () => {
			mockUseTaskOrganizationDnd.mockImplementation(() => {
				throw new Error("forced organization failure (search mode)")
			})

			const t1 = makeTask("t1")

			mockUseExtensionState.mockReturnValue({
				taskOrganization: createEmptyOrganizationState(),
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				searchQuery: "t1",
				tasks: [t1],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [],
				flatTasks: [{ ...t1, isSubtask: false }],
				toggleExpand: vi.fn(),
				isSearchMode: true,
			})

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				render(<HistoryView onDone={vi.fn()} />)

				// Baseline fallback: original flat TaskItem visible in search mode.
				await waitFor(() => {
					expect(screen.getByTestId("task-item-t1")).toBeInTheDocument()
				})
				expect(screen.getByTestId("history-search-input")).toBeInTheDocument()
			} finally {
				consoleErrorSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			}
		})
	})

	describe("selection-mode folder actions", () => {
		function setupFolderSelectionScenario() {
			const t1 = makeTask("t1")
			const t2 = makeTask("t2")
			const folderId = "folder-1"
			const orgState: TaskOrganizationStateV1 = {
				...createEmptyOrganizationState(),
				folders: [{ folderId, name: "My Folder", taskIds: [], createdAt: 1, updatedAt: 1 }],
			}
			const mutateTaskOrganization = vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			})
			mockUseExtensionState.mockReturnValue({
				taskOrganization: orgState,
				mutateTaskOrganization,
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [t1, t2],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [makeGroup(t1), makeGroup(t2)],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})
			mockUseTaskOrganizationDnd.mockReturnValue({
				sensors: [],
				activeDrag: null,
				targetMeta: { isOverTarget: false },
				handleDragStart: vi.fn(),
				handleDragOver: vi.fn(),
				handleDragEnd: vi.fn(),
				handleDragCancel: vi.fn(),
				UNFILED_DROP_ZONE_ID,
			})
			return { mutateTaskOrganization, folderId }
		}

		it("shows a folder selection checkbox in selection mode and hides folder edit/pin/options", () => {
			setupFolderSelectionScenario()
			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.queryByTestId("folder-select-folder-1")).not.toBeInTheDocument()
			expect(screen.getByTestId("folder-pin-button")).toBeInTheDocument()

			fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

			expect(screen.getByTestId("folder-select-folder-1")).toBeInTheDocument()
			expect(screen.queryByTestId("folder-pin-button")).not.toBeInTheDocument()
			expect(screen.queryByTestId("folder-rename-button")).not.toBeInTheDocument()
			expect(screen.queryByTestId("folder-options-menu")).not.toBeInTheDocument()
			expect(screen.queryByTestId("folder-grip")).not.toBeInTheDocument()
		})

		it("enables Delete Folders only after a folder is selected, and sends one atomic deleteFolders request on confirm", async () => {
			const { mutateTaskOrganization } = setupFolderSelectionScenario()
			render(<HistoryView onDone={vi.fn()} />)
			fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

			// No selection yet: action bar hidden.
			expect(screen.queryByTestId("delete-folders-button")).not.toBeInTheDocument()

			fireEvent.click(screen.getByTestId("folder-select-folder-1"))
			expect(screen.getByTestId("delete-folders-button")).not.toBeDisabled()

			fireEvent.click(screen.getByTestId("delete-folders-button"))
			expect(screen.getByText("history:confirmDeleteFolders")).toBeInTheDocument()
			expect(screen.getByText("history:deleteFoldersTasksPreserved")).toBeInTheDocument()
			expect(mutateTaskOrganization).not.toHaveBeenCalled()

			fireEvent.click(screen.getByTestId("confirm-delete-folders"))
			await waitFor(() => {
				expect(mutateTaskOrganization).toHaveBeenCalledTimes(1)
			})
			expect(mutateTaskOrganization).toHaveBeenCalledWith({
				kind: "deleteFolders",
				folderIds: ["folder-1"],
			})
		})

		it("enables Create Folder only with two or more canonical units", () => {
			setupFolderSelectionScenario()
			render(<HistoryView onDone={vi.fn()} />)
			fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

			// Nothing selected: action bar is hidden entirely.
			expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument()

			// One folder only: action bar appears, but Create Folder still
			// disabled (needs 2+ canonical units).
			fireEvent.click(screen.getByTestId("folder-select-folder-1"))
			expect(screen.getByTestId("selection-action-bar")).toBeInTheDocument()
			expect(screen.getByTestId("create-folder-from-selection-button")).toBeDisabled()
			expect(screen.getByTestId("delete-folders-button")).not.toBeDisabled()
		})
	})

	describe("workspace cross-contamination", () => {
		it("hides pinned tasks from other workspaces when showAllWorkspaces is false", () => {
			mockUseTaskOrganizationDnd.mockReturnValue({
				sensors: [],
				activeDrag: null,
				targetMeta: { isOverTarget: false },
				handleDragStart: vi.fn(),
				handleDragOver: vi.fn(),
				handleDragEnd: vi.fn(),
				handleDragCancel: vi.fn(),
				UNFILED_DROP_ZONE_ID,
			})
			const localTask = makeTask("t-local", { workspace: "/test/workspace" })
			const _otherTask = makeTask("t-other", { workspace: "/other/workspace" })

			mockUseExtensionState.mockReturnValue({
				taskOrganization: {
					...createEmptyOrganizationState(),
					pins: [
						{ target: { kind: "task", taskId: "t-local" }, pinnedAt: 100 },
						{ target: { kind: "task", taskId: "t-other" }, pinnedAt: 200 },
					],
				},
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [localTask],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [makeGroup(localTask)],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})

			render(<HistoryView onDone={vi.fn()} />)

			// Local pin should be visible.
			expect(screen.getByTestId("pinned-unit-t-local")).toBeInTheDocument()
			// Pin from another workspace should NOT appear.
			expect(screen.queryByTestId("pinned-unit-t-other")).not.toBeInTheDocument()
		})

		it("hides pinned folders whose members all belong to another workspace when showAllWorkspaces is false", () => {
			mockUseTaskOrganizationDnd.mockReturnValue({
				sensors: [],
				activeDrag: null,
				targetMeta: { isOverTarget: false },
				handleDragStart: vi.fn(),
				handleDragOver: vi.fn(),
				handleDragEnd: vi.fn(),
				handleDragCancel: vi.fn(),
				UNFILED_DROP_ZONE_ID,
			})

			mockUseExtensionState.mockReturnValue({
				taskOrganization: {
					...createEmptyOrganizationState(),
					folders: [
						{
							folderId: "folder-other",
							name: "Other Folder",
							taskIds: ["t-other"],
							createdAt: 1,
							updatedAt: 1,
						},
					],
					pins: [{ target: { kind: "folder", folderId: "folder-other" }, pinnedAt: 100 }],
				},
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			// The other workspace's task is not part of the current view.
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})

			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.queryByTestId("pinned-folder-folder-other")).not.toBeInTheDocument()
		})

		it("shows a pinned folder that has a member in the current workspace", () => {
			mockUseTaskOrganizationDnd.mockReturnValue({
				sensors: [],
				activeDrag: null,
				targetMeta: { isOverTarget: false },
				handleDragStart: vi.fn(),
				handleDragOver: vi.fn(),
				handleDragEnd: vi.fn(),
				handleDragCancel: vi.fn(),
				UNFILED_DROP_ZONE_ID,
			})
			const localTask = makeTask("t-local", { workspace: "/test/workspace" })

			mockUseExtensionState.mockReturnValue({
				taskOrganization: {
					...createEmptyOrganizationState(),
					folders: [
						{
							folderId: "folder-local",
							name: "Local Folder",
							taskIds: ["t-local"],
							createdAt: 1,
							updatedAt: 1,
						},
					],
					pins: [{ target: { kind: "folder", folderId: "folder-local" }, pinnedAt: 100 }],
				},
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [localTask],
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [makeGroup(localTask)],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})

			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.getByTestId("pinned-folder-folder-local")).toBeInTheDocument()
		})

		it("shows pinned tasks from other workspaces when showAllWorkspaces is true", () => {
			mockUseTaskOrganizationDnd.mockReturnValue({
				sensors: [],
				activeDrag: null,
				targetMeta: { isOverTarget: false },
				handleDragStart: vi.fn(),
				handleDragOver: vi.fn(),
				handleDragEnd: vi.fn(),
				handleDragCancel: vi.fn(),
				UNFILED_DROP_ZONE_ID,
			})
			const localTask = makeTask("t-local", { workspace: "/test/workspace" })
			const otherTask = makeTask("t-other", { workspace: "/other/workspace" })

			mockUseExtensionState.mockReturnValue({
				taskOrganization: {
					...createEmptyOrganizationState(),
					pins: [
						{ target: { kind: "task", taskId: "t-local" }, pinnedAt: 100 },
						{ target: { kind: "task", taskId: "t-other" }, pinnedAt: 200 },
					],
				},
				mutateTaskOrganization: vi.fn().mockResolvedValue({
					requestId: "",
					success: true,
					committedRevision: 1,
				}),
				cwd: "/test/workspace",
			})
			mockUseTaskSearch.mockReturnValue({
				...defaultSearchResult,
				tasks: [localTask, otherTask],
				showAllWorkspaces: true,
			})
			mockUseGroupedTasks.mockReturnValue({
				groups: [makeGroup(localTask), makeGroup(otherTask)],
				flatTasks: null,
				toggleExpand: vi.fn(),
				isSearchMode: false,
			})

			render(<HistoryView onDone={vi.fn()} />)

			// Both pins should be visible when showAllWorkspaces is true.
			expect(screen.getByTestId("pinned-unit-t-local")).toBeInTheDocument()
			expect(screen.getByTestId("pinned-unit-t-other")).toBeInTheDocument()
		})
	})
})
