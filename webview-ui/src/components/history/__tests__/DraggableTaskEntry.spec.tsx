import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { DndContext } from "@dnd-kit/core"

import { DraggableTaskEntry } from "../DraggableTaskEntry"
import type { DndItemData } from "../useTaskOrganizationDnd"

// Wrap in DndContext so the hooks have a provider.
const Wrapper = ({ children }: { children: React.ReactNode }) => (
	<DndContext onDragEnd={() => {}}>{children}</DndContext>
)

const renderWithDnd = (ui: React.ReactElement) => render(<Wrapper>{ui}</Wrapper>)

const makeTaskData = (taskId: string): DndItemData => ({
	kind: "task",
	target: { kind: "task", taskId },
})

const makeFolderMemberData = (taskId: string, folderId: string): DndItemData => ({
	kind: "task",
	target: { kind: "task", taskId },
	folderId,
})

const makeAutoGroupData = (rootTaskId: string): DndItemData => ({
	kind: "task",
	target: { kind: "autoGroup", rootTaskId },
})

describe("DraggableTaskEntry", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// ── No grip ──────────────────────────────────────────────────────────

	it("does not render a grip handle", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.queryByTestId("task-grip")).not.toBeInTheDocument()
	})

	it("does not render a grip handle even when enabled", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")} disabled={false}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.queryByTestId("task-grip")).not.toBeInTheDocument()
	})

	// ── Wrapper receives drag attributes/listeners ───────────────────────

	it("attaches draggable attributes to the outer wrapper", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div data-testid="child">Child</div>
			</DraggableTaskEntry>,
		)

		const wrapper = screen.getByTestId("draggable-entry-task-1")
		// role is deliberately stripped from dnd-kit attributes so the wrapper
		// is not matched by interactive selectors (see DraggableTaskEntry.tsx).
		// dnd-kit only emits aria-pressed alongside role="button", so it is
		// absent here as well.
		expect(wrapper).not.toHaveAttribute("role")
		expect(wrapper).not.toHaveAttribute("aria-pressed")
		expect(wrapper).toHaveAttribute("tabindex", "0")
		expect(wrapper).toHaveAttribute("aria-roledescription", "draggable")
		expect(wrapper).toHaveAttribute("data-droppable-id", "drop-task-1")
		expect(wrapper).toHaveAttribute("data-dragging", "false")
	})

	it("wrapper remains a drop target via data-droppable-id", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-42" dndData={makeTaskData("task-42")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("draggable-entry-task-42")).toHaveAttribute("data-droppable-id", "drop-task-42")
	})

	// ── Children-only rendering ──────────────────────────────────────────

	it("renders children exactly once and nothing else", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<span data-testid="provided-child">Only this child</span>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("provided-child")).toBeInTheDocument()
		const wrapper = screen.getByTestId("draggable-entry-task-1")
		// Wrapper should contain only the provided child
		expect(wrapper.children).toHaveLength(1)
		expect(wrapper.children[0]).toBe(screen.getByTestId("provided-child"))
	})

	it("does not render TaskItem or TaskGroupItem internally", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div data-testid="child">Content</div>
			</DraggableTaskEntry>,
		)

		// No internal task/group renderers — only children appear
		expect(screen.queryByTestId("task-item")).not.toBeInTheDocument()
		expect(screen.queryByTestId("task-group-item")).not.toBeInTheDocument()
	})

	// ── Disabled behavior ────────────────────────────────────────────────

	it("disabled wrapper still renders children and drop target id", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")} disabled>
				<div data-testid="child">Content</div>
			</DraggableTaskEntry>,
		)

		const wrapper = screen.getByTestId("draggable-entry-task-1")
		expect(wrapper).toHaveAttribute("data-droppable-id", "drop-task-1")
		expect(screen.getByTestId("child")).toBeInTheDocument()
	})

	it("defaults disabled to false when not specified", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		// Wrapper has draggable attributes → not disabled
		// (role/aria-pressed are stripped by design; tabindex="0" and
		// aria-roledescription prove draggability)
		const wrapper = screen.getByTestId("draggable-entry-task-1")
		expect(wrapper).not.toHaveAttribute("role")
		expect(wrapper).toHaveAttribute("tabindex", "0")
		expect(wrapper).toHaveAttribute("aria-roledescription", "draggable")
	})

	// ── Metadata variants ────────────────────────────────────────────────

	it("carries folderId in metadata for folder members", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeFolderMemberData("task-1", "folder-abc")}>
				<div data-testid="child">Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("draggable-entry-task-1")).toBeInTheDocument()
		expect(screen.getByTestId("child")).toBeInTheDocument()
	})

	it("carries autoGroup target metadata", () => {
		renderWithDnd(
			<DraggableTaskEntry id="root-1" dndData={makeAutoGroupData("root-1")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("draggable-entry-root-1")).toBeInTheDocument()
	})

	// ── Click preservation on interactive children ───────────────────────

	it("passes click events through to interactive children", () => {
		const onClick = vi.fn()
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<button data-testid="custom-button" onClick={onClick}>
					Click
				</button>
			</DraggableTaskEntry>,
		)

		fireEvent.click(screen.getByTestId("custom-button"))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	// ── Visual states ────────────────────────────────────────────────────

	it("starts in non-dragging state", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("draggable-entry-task-1")).toHaveAttribute("data-dragging", "false")
	})

	it("applies className to the wrapper", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")} className="custom-class">
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		expect(screen.getByTestId("draggable-entry-task-1").className).toContain("custom-class")
	})

	it("exposes distinct draggable and droppable identifiers", () => {
		renderWithDnd(
			<DraggableTaskEntry id="task-1" dndData={makeTaskData("task-1")}>
				<div>Child</div>
			</DraggableTaskEntry>,
		)

		const droppableId = screen.getByTestId("draggable-entry-task-1").getAttribute("data-droppable-id")
		expect(droppableId).toBe("drop-task-1")
		expect(droppableId).not.toBe("drag-task-1")
	})
})
