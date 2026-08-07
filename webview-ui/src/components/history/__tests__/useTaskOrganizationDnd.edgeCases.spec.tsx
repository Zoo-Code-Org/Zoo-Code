import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { type DragEndEvent, type DragStartEvent, type DragOverEvent } from "@dnd-kit/core"

import { useTaskOrganizationDnd, type DndItemData, UNFILED_DROP_ZONE_ID } from "../useTaskOrganizationDnd"

const mockCallbacks = () => ({
	onRequestCreateFolder: vi.fn(),
	onRequestMoveToFolder: vi.fn(),
	onRequestRemoveFromFolder: vi.fn(),
	onCancel: vi.fn(),
})

const makeTarget = (id: string): DndItemData => ({
	kind: "task",
	target: { kind: "task", taskId: id },
})

const makeFolderTarget = (folderId: string): DndItemData => ({
	kind: "folder",
	target: { kind: "folder", folderId },
	folderId,
})

const makeFolderMemberTarget = (taskId: string, folderId: string): DndItemData => ({
	kind: "task",
	target: { kind: "task", taskId },
	folderId,
})

const makeAutoGroupTarget = (rootTaskId: string, folderId?: string): DndItemData => ({
	kind: "task",
	target: { kind: "autoGroup", rootTaskId },
	folderId,
})

describe("useTaskOrganizationDnd edge cases", () => {
	it("handleDragStart ignores invalid data (no target)", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-x", data: { current: null } },
			} as unknown as DragStartEvent)
		})

		expect(result.current.activeDrag).toBeNull()
	})

	it("handleDragStart ignores data with invalid target kind", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-x", data: { current: { kind: "task", target: { kind: "invalid" } } } },
			} as unknown as DragStartEvent)
		})

		expect(result.current.activeDrag).toBeNull()
	})

	it("handleDragMove clears target meta when overId is undefined", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		// Start drag first
		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		// Move over nothing
		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: undefined,
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("handleDragMove clears target meta when overId equals active id", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("handleDragMove sets meta for over item with no valid data", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "some-other-id", data: { current: null } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("handleDragMove falls back to event.active.data when activeDragRef is null", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		// Call handleDragMove without calling handleDragStart first
		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: UNFILED_DROP_ZONE_ID, data: { current: null } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("unfiled")
	})

	it("handleDragEnd calls onCancel when activeData cannot be extracted", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		// Call handleDragEnd without a preceding dragStart and with invalid data
		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-x", data: { current: null } },
				over: { id: "some-target", data: { current: makeTarget("b") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
		expect(callbacks.onRequestCreateFolder).not.toHaveBeenCalled()
		expect(callbacks.onRequestMoveToFolder).not.toHaveBeenCalled()
	})

	it("handleDragEnd cancels when dropping on Unfiled zone but source has no folderId", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: UNFILED_DROP_ZONE_ID, data: { current: null } },
			} as unknown as DragEndEvent)
		})

		// Source is unfiled (no folderId), so dropping on Unfiled zone is a no-op
		// but it doesn't call onCancel because it's not an error, just a no-op
		expect(callbacks.onRequestRemoveFromFolder).not.toHaveBeenCalled()
	})

	it("handleDragEnd moves folder member to a different folder", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: "folder-drop-f2", data: { current: makeFolderTarget("f2") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestMoveToFolder).toHaveBeenCalledWith({ kind: "task", taskId: "a" }, "f2")
		expect(callbacks.onCancel).not.toHaveBeenCalled()
	})

	it("handleDragEnd cancels when dropping folder member onto same folder header", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: "folder-drop-f1", data: { current: makeFolderTarget("f1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
		expect(callbacks.onRequestMoveToFolder).not.toHaveBeenCalled()
	})

	it("handleDragEnd cancels when dropping on same autoGroup target", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeAutoGroupTarget("root-1") } },
				over: { id: "drag-b", data: { current: makeAutoGroupTarget("root-1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
		expect(callbacks.onRequestCreateFolder).not.toHaveBeenCalled()
	})

	it("handleDragEnd cancels when dropping on same folder target", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-f1", data: { current: makeFolderTarget("f1") } },
				over: { id: "drag-f1-dup", data: { current: makeFolderTarget("f1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
		expect(callbacks.onRequestCreateFolder).not.toHaveBeenCalled()
	})

	it("handleDragEnd creates folder when dropping unfiled task onto autoGroup", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-g1", data: { current: makeAutoGroupTarget("root-1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestCreateFolder).toHaveBeenCalledWith(
			{ kind: "task", taskId: "a" },
			{ kind: "autoGroup", rootTaskId: "root-1" },
		)
	})

	it("handleDragEnd creates folder when dropping folder member onto unfiled task", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: "drag-b", data: { current: makeTarget("b") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestCreateFolder).toHaveBeenCalledWith(
			{ kind: "task", taskId: "a" },
			{ kind: "task", taskId: "b" },
		)
	})

	it("handleDragCancel clears state and calls onCancel", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		// Start a drag first
		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		expect(result.current.activeDrag).not.toBeNull()

		act(() => {
			result.current.handleDragCancel()
		})

		expect(result.current.activeDrag).toBeNull()
		expect(result.current.targetMeta.isOverTarget).toBe(false)
		expect(callbacks.onCancel).toHaveBeenCalled()
	})

	it("handleDragMove sets target meta for pinned items", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		const pinnedData: DndItemData = {
			kind: "pinned",
			target: { kind: "task", taskId: "a" },
			isPinned: true,
		}

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: pinnedData } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: pinnedData } },
				over: { id: "drag-b", data: { current: makeTarget("b") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("task")
	})

	it("folder dropped on another folder triggers moveToFolder (not createFolder)", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		// Drag a folder onto another folder header - overData.kind is "folder"
		// so it goes through the moveToFolder path (line 203-210)
		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-f1", data: { current: makeFolderTarget("f1") } },
				over: { id: "folder-drop-f2", data: { current: makeFolderTarget("f2") } },
			} as unknown as DragEndEvent)
		})

		// resolveSourceFolderId returns undefined for folder kind, so
		// sourceFolderId (undefined) !== overData.folderId ("f2"), and moveToFolder is called
		expect(callbacks.onRequestMoveToFolder).toHaveBeenCalledWith({ kind: "folder", folderId: "f1" }, "f2")
	})

	it("handleDragMove with overData that has folderId sets targetFolderId", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragMove({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-b", data: { current: makeFolderMemberTarget("b", "f1") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("task")
		expect(result.current.targetMeta.targetFolderId).toBe("f1")
	})
})
