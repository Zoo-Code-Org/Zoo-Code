import { useCallback, useMemo, useRef, useState } from "react"
import {
	type DragEndEvent,
	type DragMoveEvent,
	type DragOverEvent,
	type DragStartEvent,
	KeyboardSensor,
	useSensor,
	useSensors,
	type UniqueIdentifier,
} from "@dnd-kit/core"

import type { TaskOrganizationTargetV1 } from "@roo-code/types"

import { TaskOrganizationPointerSensor } from "./TaskOrganizationPointerSensor"

export type DndItemKind = "task" | "folder" | "pinned"

export interface DndItemData {
	kind: DndItemKind
	/** The canonical organization target represented by this draggable. */
	target: TaskOrganizationTargetV1
	/** For folder targets, the folder ID. */
	folderId?: string
	/** True when the source row is itself a pinned shortcut. */
	isPinned?: boolean
}

export interface ActiveDragState {
	id: UniqueIdentifier
	data: DndItemData
}

export interface DndTargetMeta {
	/** True if the current pointer is over a valid drop target. */
	isOverTarget: boolean
	/** The kind of the currently hovered target, if any. */
	targetKind?: DndItemKind | "unfiled"
	/** The folder ID of the hovered target, if any. */
	targetFolderId?: string
}

export interface UseTaskOrganizationDndOptions {
	/**
	 * Called when a drop requires creating a new folder from a source and
	 * destination unit. The host mutation will be requested elsewhere.
	 */
	onRequestCreateFolder: (source: TaskOrganizationTargetV1, destination: TaskOrganizationTargetV1) => void
	/**
	 * Called when a drop should move the source unit into an existing folder.
	 */
	onRequestMoveToFolder: (source: TaskOrganizationTargetV1, folderId: string) => void
	/**
	 * Called when a drop should remove the source unit from its current folder.
	 */
	onRequestRemoveFromFolder: (source: TaskOrganizationTargetV1, folderId: string) => void
	/**
	 * Called when the user cancels a drag or drops on an invalid target.
	 */
	onCancel?: () => void
}

export const UNFILED_DROP_ZONE_ID = "task-org-unfiled-drop-zone"

const pointerActivationConstraint = {
	distance: 6,
}

function isSameTarget(a: TaskOrganizationTargetV1, b: TaskOrganizationTargetV1): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === "task" && b.kind === "task") return a.taskId === b.taskId
	if (a.kind === "autoGroup" && b.kind === "autoGroup") return a.rootTaskId === b.rootTaskId
	if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId
	return false
}

function extractDndItemData(input: unknown): DndItemData | undefined {
	if (!input || typeof input !== "object") return undefined
	const data = input as Record<string, unknown>
	if (!data.target || typeof data.target !== "object") return undefined
	const target = data.target as { kind?: unknown }
	if (target.kind !== "task" && target.kind !== "autoGroup" && target.kind !== "folder") return undefined
	return {
		kind: data.kind === "folder" || data.kind === "pinned" ? data.kind : "task",
		target: data.target as TaskOrganizationTargetV1,
		folderId: typeof data.folderId === "string" ? data.folderId : undefined,
		isPinned: data.isPinned === true,
	}
}

/**
 * Configures dnd-kit sensors and exposes a drag-state controller for task
 * organization. The hook does not render the DndContext; the view composes
 * DndContext and DragOverlay around the returned handlers and sensors.
 */
export function useTaskOrganizationDnd(options: UseTaskOrganizationDndOptions) {
	const { onRequestCreateFolder, onRequestMoveToFolder, onRequestRemoveFromFolder, onCancel } = options

	const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null)
	const [targetMeta, setTargetMeta] = useState<DndTargetMeta>({ isOverTarget: false })
	const activeDragRef = useRef<ActiveDragState | null>(null)

	const pointerSensor = useSensor(TaskOrganizationPointerSensor, {
		activationConstraint: pointerActivationConstraint,
	})

	const keyboardSensor = useSensor(KeyboardSensor)

	const sensors = useSensors(pointerSensor, keyboardSensor)

	const handleDragStart = useCallback((event: DragStartEvent) => {
		const data = extractDndItemData(event.active.data.current)
		if (!data) return
		const next = { id: event.active.id, data }
		setActiveDrag(next)
		activeDragRef.current = next
		setTargetMeta({ isOverTarget: false })
	}, [])

	const handleDragMove = useCallback((event: DragMoveEvent) => {
		const active = activeDragRef.current ?? extractDndItemData(event.active.data.current)
		const overId = event.over?.id
		if (!active || overId === undefined || overId === event.active.id) {
			setTargetMeta({ isOverTarget: false })
			return
		}

		const overData = extractDndItemData(event.over?.data.current)
		if (overId === UNFILED_DROP_ZONE_ID) {
			setTargetMeta({ isOverTarget: true, targetKind: "unfiled" })
			return
		}

		if (overData) {
			setTargetMeta({
				isOverTarget: true,
				targetKind: overData.kind,
				targetFolderId: overData.folderId,
			})
			return
		}

		setTargetMeta({ isOverTarget: false })
	}, [])

	const handleDragOver = useCallback(
		(event: DragOverEvent) => {
			handleDragMove(event as unknown as DragMoveEvent)
		},
		[handleDragMove],
	)

	const resolveSourceFolderId = useCallback((data: DndItemData): string | undefined => {
		if (data.kind === "folder") return undefined
		return data.folderId
	}, [])

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const activeData = activeDragRef.current?.data ?? extractDndItemData(event.active.data.current)
			activeDragRef.current = null
			setActiveDrag(null)
			setTargetMeta({ isOverTarget: false })

			if (!activeData) {
				onCancel?.()
				return
			}

			const overId = event.over?.id
			if (!overId || overId === event.active.id) {
				onCancel?.()
				return
			}

			const source = activeData.target
			const overData = extractDndItemData(event.over?.data.current)

			// Drop on the Unfiled zone removes the source from its folder.
			if (overId === UNFILED_DROP_ZONE_ID) {
				const sourceFolderId = resolveSourceFolderId(activeData)
				if (sourceFolderId) {
					onRequestRemoveFromFolder(source, sourceFolderId)
				}
				return
			}

			if (!overData) {
				onCancel?.()
				return
			}

			const destination = overData.target

			// Dropping a unit on itself or on a member of the same automatic
			// closure is a no-op.
			if (isSameTarget(source, destination)) {
				onCancel?.()
				return
			}

			// Dropping on a folder header or member moves the unit into that folder.
			if (overData.kind === "folder" && overData.folderId) {
				const sourceFolderId = resolveSourceFolderId(activeData)
				if (sourceFolderId === overData.folderId) {
					onCancel?.()
					return
				}
				onRequestMoveToFolder(source, overData.folderId)
				return
			}

			// Dropping a folder member onto another member of the same folder is a no-op.
			const sourceFolderId = resolveSourceFolderId(activeData)
			if (sourceFolderId && overData.folderId === sourceFolderId) {
				onCancel?.()
				return
			}

			// Dropping a folder member onto a different folder member or an unfiled
			// unit creates a new folder.
			if (sourceFolderId) {
				onRequestCreateFolder(source, destination)
				return
			}

			// Dropping an unfiled unit onto another unfiled unit creates a folder.
			onRequestCreateFolder(source, destination)
		},
		[onCancel, onRequestCreateFolder, onRequestMoveToFolder, onRequestRemoveFromFolder, resolveSourceFolderId],
	)

	const handleDragCancel = useCallback(() => {
		activeDragRef.current = null
		setActiveDrag(null)
		setTargetMeta({ isOverTarget: false })
		onCancel?.()
	}, [onCancel])

	return useMemo(
		() => ({
			sensors,
			activeDrag,
			targetMeta,
			handleDragStart,
			handleDragMove,
			handleDragOver,
			handleDragEnd,
			handleDragCancel,
			UNFILED_DROP_ZONE_ID,
		}),
		[
			sensors,
			activeDrag,
			targetMeta,
			handleDragStart,
			handleDragMove,
			handleDragOver,
			handleDragEnd,
			handleDragCancel,
		],
	)
}
