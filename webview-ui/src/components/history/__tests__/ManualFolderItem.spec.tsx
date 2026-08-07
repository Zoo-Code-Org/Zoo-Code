import React from "react"
import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { DndContext } from "@dnd-kit/core"
import { ManualFolderItem, ManualFolderMemberItem } from "../ManualFolderItem"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			if (key === "history:tasks" && options?.count !== undefined) {
				return `${options.count} tasks`
			}
			if (!options) return key
			return Object.entries(options).reduce(
				(acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v)),
				key,
			)
		},
	}),
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
	DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
		asChild ? <>{children}</> : <div data-testid="dropdown-trigger">{children}</div>,
	DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="dropdown-content">{children}</div>
	),
	DropdownMenuItem: ({
		children,
		onClick,
		"data-testid": dataTestId,
	}: {
		children: React.ReactNode
		onClick?: () => void
		"data-testid"?: string
	}) => (
		<div onClick={onClick} data-testid={dataTestId ?? "dropdown-item"}>
			{children}
		</div>
	),
}))

const Wrapper = ({ children }: { children: React.ReactNode }) => (
	<DndContext onDragEnd={() => {}}>{children}</DndContext>
)

const renderWithDnd = (ui: React.ReactElement) => render(<Wrapper>{ui}</Wrapper>)

describe("ManualFolderItem", () => {
	it("renders folder name and unit count", () => {
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={3}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("folder-name")).toHaveTextContent("My Folder")
		expect(screen.getByTestId("folder-count")).toHaveTextContent("3 tasks")
	})

	it("toggles expansion when the expand button is clicked", () => {
		const onToggleExpand = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={onToggleExpand}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-expand-toggle"))
		expect(onToggleExpand).toHaveBeenCalledTimes(1)
	})

	it("enters inline rename mode and calls onRename with valid name", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input")
		expect(input).toBeInTheDocument()

		fireEvent.change(input, { target: { value: "Renamed Folder" } })
		fireEvent.blur(input)

		expect(onRename).toHaveBeenCalledWith("Renamed Folder")
	})

	it("shows validation error for an empty folder name", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "   " } })
		fireEvent.blur(input)

		expect(screen.getByTestId("folder-name-error")).toBeInTheDocument()
		expect(onRename).not.toHaveBeenCalled()
	})

	it("shows validation error for a folder name with control characters", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "Bad\u0000Name" } })
		fireEvent.blur(input)

		expect(screen.getByTestId("folder-name-error")).toBeInTheDocument()
		expect(onRename).not.toHaveBeenCalled()
	})

	it("calls onDelete when delete option is selected", async () => {
		const user = userEvent.setup()
		const onDelete = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={onDelete}
				onTogglePin={vi.fn()}
			/>,
		)

		await user.click(screen.getByTestId("folder-options-menu"))
		await waitFor(() => expect(screen.getByTestId("folder-delete-option")).toBeInTheDocument())
		await user.click(screen.getByTestId("folder-delete-option"))

		expect(onDelete).toHaveBeenCalledTimes(1)
	})

	it("calls onTogglePin when pin button is clicked", () => {
		const onTogglePin = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={onTogglePin}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-pin-button"))
		expect(onTogglePin).toHaveBeenCalledTimes(1)
	})

	it("renders a selection checkbox in selection mode and hides edit/pin/options controls", () => {
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
				isSelectionMode={true}
				isSelected={false}
				onToggleSelection={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("folder-select-f1")).toBeInTheDocument()
		expect(screen.queryByTestId("folder-grip")).not.toBeInTheDocument()
		expect(screen.queryByTestId("folder-pin-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("folder-rename-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("folder-options-menu")).not.toBeInTheDocument()
	})

	it("invokes onToggleSelection when the folder checkbox is toggled", () => {
		const onToggleSelection = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
				isSelectionMode={true}
				isSelected={false}
				onToggleSelection={onToggleSelection}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-select-f1"))
		expect(onToggleSelection).toHaveBeenCalledWith("f1", true)
	})

	it("reflects the selected state on the folder checkbox", () => {
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
				isSelectionMode={true}
				isSelected={true}
				onToggleSelection={vi.fn()}
			/>,
		)

		const checkbox = screen.getByTestId("folder-select-f1") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("renders children when expanded", () => {
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={1}
				isExpanded={true}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}>
				<div data-testid="child-content">Child</div>
			</ManualFolderItem>,
		)

		expect(screen.getByTestId("child-content")).toBeInTheDocument()
	})

	it("cancels rename via Escape and restores the original name", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "Edited Name" } })
		fireEvent.keyDown(input, { key: "Escape" })

		// isEditing is cleared, the input unmounts, and no rename is committed.
		expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
		expect(onRename).not.toHaveBeenCalled()
		expect(screen.getByTestId("folder-name")).toHaveTextContent("My Folder")
	})

	it("commits rename via Enter key", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "New Name" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(onRename).toHaveBeenCalledWith("New Name")
		expect(screen.queryByTestId("folder-name-input")).not.toBeInTheDocument()
	})

	it("rejects a folder name longer than the max length", () => {
		const onRename = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={onRename}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-rename-button"))
		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "x".repeat(81) } })
		fireEvent.blur(input)

		expect(screen.getByTestId("folder-name-error")).toBeInTheDocument()
		expect(onRename).not.toHaveBeenCalled()
	})

	it("enters rename mode from the dropdown rename option", async () => {
		const user = userEvent.setup()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={0}
				isExpanded={false}
				isPinned={false}
				canPin={true}
				onToggleExpand={vi.fn()}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}
			/>,
		)

		await user.click(screen.getByTestId("folder-options-menu"))
		await waitFor(() => expect(screen.getByTestId("folder-rename-option")).toBeInTheDocument())
		await user.click(screen.getByTestId("folder-rename-option"))

		expect(screen.getByTestId("folder-name-input")).toBeInTheDocument()
	})

	it("stops click propagation from the expanded children container", () => {
		const onToggleExpand = vi.fn()
		renderWithDnd(
			<ManualFolderItem
				folderId="f1"
				name="My Folder"
				unitCount={1}
				isExpanded={true}
				isPinned={false}
				canPin={true}
				onToggleExpand={onToggleExpand}
				onRename={vi.fn()}
				onDelete={vi.fn()}
				onTogglePin={vi.fn()}>
				<div data-testid="child-content">Child</div>
			</ManualFolderItem>,
		)

		const children = screen.getByTestId("folder-children")
		const clickEvent = new MouseEvent("click", { bubbles: true })
		const stopSpy = vi.spyOn(clickEvent, "stopPropagation")
		fireEvent(children, clickEvent)
		expect(stopSpy).toHaveBeenCalled()
	})
})

describe("ManualFolderMemberItem", () => {
	it("renders children inside a droppable member wrapper", () => {
		const unit = {
			rootTaskId: "task-1",
			target: { kind: "task", taskId: "task-1" },
		} as any

		renderWithDnd(
			<ManualFolderMemberItem unit={unit} folderId="f1">
				<div data-testid="member-child">Member</div>
			</ManualFolderMemberItem>,
		)

		expect(screen.getByTestId("member-child")).toBeInTheDocument()
		// Default testid derives from the unit root id.
		expect(screen.getByTestId("folder-member-task-1")).toBeInTheDocument()
	})

	it("uses the provided data-testid when present", () => {
		const unit = {
			rootTaskId: "task-2",
			target: { kind: "task", taskId: "task-2" },
		} as any

		renderWithDnd(
			<ManualFolderMemberItem unit={unit} folderId="f1" data-testid="custom-member">
				<div>Member</div>
			</ManualFolderMemberItem>,
		)

		expect(screen.getByTestId("custom-member")).toBeInTheDocument()
	})
})
