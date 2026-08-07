import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { type DragEndEvent, type DragStartEvent, type DragOverEvent } from "@dnd-kit/core"

import { KeyboardSensor } from "@dnd-kit/core"

import { useTaskOrganizationDnd, type DndItemData, UNFILED_DROP_ZONE_ID } from "../useTaskOrganizationDnd"
import { TaskOrganizationPointerSensor } from "../TaskOrganizationPointerSensor"

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

describe("useTaskOrganizationDnd", () => {
	it("starts with no active drag", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))
		expect(result.current.activeDrag).toBeNull()
		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("captures the canonical source target at drag start", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))
		const data = makeTarget("a")

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: data } },
			} as unknown as DragStartEvent)
		})

		expect(result.current.activeDrag).not.toBeNull()
		expect(result.current.activeDrag?.data.target).toEqual(data.target)
	})

	it("updates target meta when hovering over the Unfiled drop zone", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragOver({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: UNFILED_DROP_ZONE_ID, data: { current: null } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("unfiled")
	})

	it("updates target meta when hovering over a folder header", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragOver({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "folder-drop-f1", data: { current: makeFolderTarget("f1") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("folder")
		expect(result.current.targetMeta.targetFolderId).toBe("f1")
	})

	it("requests moveToFolder when dropping an unfiled task onto a folder", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "folder-drop-f1", data: { current: makeFolderTarget("f1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestMoveToFolder).toHaveBeenCalledWith({ kind: "task", taskId: "a" }, "f1")
		expect(callbacks.onCancel).not.toHaveBeenCalled()
	})

	it("requests removeFromFolder when dropping a folder member onto the Unfiled zone", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: UNFILED_DROP_ZONE_ID, data: { current: null } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestRemoveFromFolder).toHaveBeenCalledWith({ kind: "task", taskId: "a" }, "f1")
	})

	it("requests createFolder when dropping an unfiled task onto another unfiled task", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-b", data: { current: makeTarget("b") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onRequestCreateFolder).toHaveBeenCalledWith(
			{ kind: "task", taskId: "a" },
			{ kind: "task", taskId: "b" },
		)
	})

	it("requests createFolder when dropping a folder member onto another unit", () => {
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

	it("cancels when dropping a unit on itself", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
		expect(callbacks.onRequestCreateFolder).not.toHaveBeenCalled()
	})

	it("cancels when dropping a folder member on a member of the same folder", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: "drag-b", data: { current: makeFolderMemberTarget("b", "f1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
	})

	it("cancels when dropping on an invalid target", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: null,
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalled()
	})

	it("registers TaskOrganizationPointerSensor and KeyboardSensor", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))
		const sensorList = result.current.sensors
		expect(sensorList).toHaveLength(2)
		const sensorClasses = sensorList.map((s: { sensor: new (...args: never[]) => unknown }) => s.sensor)
		expect(sensorClasses).toContain(TaskOrganizationPointerSensor)
		expect(sensorClasses).toContain(KeyboardSensor)
	})

	it("exports UNFILED_DROP_ZONE_ID as a stable constant", () => {
		expect(UNFILED_DROP_ZONE_ID).toBe("task-org-unfiled-drop-zone")
	})

	it("resets active drag and meta on cancel", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragCancel()
		})

		expect(result.current.activeDrag).toBeNull()
		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("triggers handleDragOver and updates target meta when hovering over valid target", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragOver({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drop-b", data: { current: makeTarget("b") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(true)
		expect(result.current.targetMeta.targetKind).toBe("task")
	})

	it("calls onCancel when dropping an item onto itself", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drop-a", data: { current: makeTarget("a") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
	})

	it("calls onCancel when dropping a folder member into its current folder header", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeFolderMemberTarget("a", "f1") } },
				over: { id: "drop-f1", data: { current: makeFolderTarget("f1") } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
	})

	it("calls onCancel when dropping onto a target without dnd item data", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "some-other-element", data: { current: null } },
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
	})

	it("handles handleDragStart with invalid drag data", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-invalid", data: { current: { invalid: true } } },
			} as unknown as DragStartEvent)
		})

		expect(result.current.activeDrag).toBeNull()
	})

	it("sets isOverTarget false when dragging over self", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragOver({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("sets isOverTarget false when hovering over an element with unknown over data", () => {
		const { result } = renderHook(() => useTaskOrganizationDnd(mockCallbacks()))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragOver({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: { id: "unknown-zone", data: { current: { foo: "bar" } } },
			} as unknown as DragOverEvent)
		})

		expect(result.current.targetMeta.isOverTarget).toBe(false)
	})

	it("calls onCancel and resets activeDrag on handleDragCancel", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

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
		expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
	})

	it("calls onCancel when handleDragEnd has no over target", () => {
		const callbacks = mockCallbacks()
		const { result } = renderHook(() => useTaskOrganizationDnd(callbacks))

		act(() => {
			result.current.handleDragStart({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
			} as unknown as DragStartEvent)
		})

		act(() => {
			result.current.handleDragEnd({
				active: { id: "drag-a", data: { current: makeTarget("a") } },
				over: null,
			} as unknown as DragEndEvent)
		})

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
	})
})
