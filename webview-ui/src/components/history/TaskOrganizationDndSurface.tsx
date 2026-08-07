import React, { useCallback, useEffect, useMemo, useState } from "react"
import { DndContext, DragOverlay } from "@dnd-kit/core"

import type { TaskOrganizationTargetV1 } from "@roo-code/types"

import { useTaskOrganization } from "./TaskOrganizationInteractionContext"
import { FolderNameDialog } from "./FolderNameDialog"
import { useTaskOrganizationDnd } from "./useTaskOrganizationDnd"
import type { ActiveDragState } from "./useTaskOrganizationDnd"

/**
 * Pending task-on-task drop awaiting a folder name.
 */
export interface PendingFolderDraft {
	source: TaskOrganizationTargetV1
	destination: TaskOrganizationTargetV1
}

/**
 * Render state handed to the surface's children so the host view can render
 * DnD-aware affordances (e.g. the Unfiled drop zone) inside the DndContext.
 */
export interface TaskOrganizationDndSurfaceRenderState {
	/** True while a folder member is being dragged (Unfiled zone is relevant). */
	isFolderMemberDragActive: boolean
	/** The currently active drag, if any. */
	activeDrag: ActiveDragState | null
}

/**
 * Props for {@link TaskOrganizationDndSurface}.
 * The host view supplies the enable flag, a label resolver for the drag
 * overlay, and the content to render inside the DnD context.
 */
export interface TaskOrganizationDndSurfaceProps {
	/** Master switch: when false, any pending folder draft is cancelled. */
	enabled: boolean
	/**
	 * Resolves the DragOverlay label for the active drag. The host owns the
	 * data needed to render a human-readable label (tasks, folder names).
	 */
	resolveDragLabel: (activeDrag: ActiveDragState) => React.ReactNode
	/**
	 * Content rendered inside the DndContext. May be a function receiving the
	 * current render state, or a plain node.
	 */
	children: React.ReactNode | ((state: TaskOrganizationDndSurfaceRenderState) => React.ReactNode)
}

/**
 * Shared task-organization DnD surface.
 *
 * Owns the DnD controller (sensors + drag handlers), the DragOverlay, the
 * pending folder-name draft, and the folder-name dialog orchestration.
 * Mutations flow through TaskOrganizationInteractionContext, which the host
 * must provide above this component. The host keeps ownership of grouped
 * projection, pins, folders, and Unfiled rendering; this surface only wraps
 * them with drag-and-drop behavior.
 */
export const TaskOrganizationDndSurface: React.FC<TaskOrganizationDndSurfaceProps> = ({
	enabled,
	resolveDragLabel,
	children,
}) => {
	const { organization, createFolder, moveToFolder, removeFromFolder } = useTaskOrganization()

	const [pendingFolderDraft, setPendingFolderDraft] = useState<PendingFolderDraft | null>(null)

	// Cancel any pending draft when DnD is disabled or the organization
	// revision changes underneath us (e.g. a mutation from another view).
	useEffect(() => {
		if (!enabled) {
			setPendingFolderDraft(null)
		}
	}, [enabled])

	useEffect(() => {
		setPendingFolderDraft(null)
	}, [organization.revision])

	const handleRequestCreateFolder = useCallback(
		(source: TaskOrganizationTargetV1, destination: TaskOrganizationTargetV1) => {
			if (!enabled) return
			setPendingFolderDraft({ source, destination })
		},
		[enabled],
	)

	const handleRequestMoveToFolder = useCallback(
		(source: TaskOrganizationTargetV1, folderId: string) => {
			if (!enabled) return
			void moveToFolder(source, folderId)
		},
		[enabled, moveToFolder],
	)

	const handleRequestRemoveFromFolder = useCallback(
		(source: TaskOrganizationTargetV1, folderId: string) => {
			if (!enabled) return
			void removeFromFolder(source, folderId)
		},
		[enabled, removeFromFolder],
	)

	const { sensors, activeDrag, handleDragStart, handleDragOver, handleDragEnd, handleDragCancel } =
		useTaskOrganizationDnd({
			onRequestCreateFolder: handleRequestCreateFolder,
			onRequestMoveToFolder: handleRequestMoveToFolder,
			onRequestRemoveFromFolder: handleRequestRemoveFromFolder,
		})

	const handleConfirmFolderName = useCallback(
		(name: string) => {
			if (!pendingFolderDraft) return
			void createFolder(name, pendingFolderDraft.source, pendingFolderDraft.destination)
			setPendingFolderDraft(null)
		},
		[createFolder, pendingFolderDraft],
	)

	const handleCancelFolderName = useCallback(() => {
		setPendingFolderDraft(null)
	}, [])

	// The Unfiled drop zone is only relevant while a folder member is being dragged.
	const isFolderMemberDragActive =
		activeDrag !== null && activeDrag.data.kind !== "folder" && !!activeDrag.data.folderId

	const renderState = useMemo<TaskOrganizationDndSurfaceRenderState>(
		() => ({ isFolderMemberDragActive, activeDrag }),
		[isFolderMemberDragActive, activeDrag],
	)

	const overlayLabel = activeDrag ? resolveDragLabel(activeDrag) : null

	return (
		<DndContext
			sensors={sensors}
			onDragStart={handleDragStart}
			onDragOver={handleDragOver}
			onDragEnd={handleDragEnd}
			onDragCancel={handleDragCancel}>
			{typeof children === "function" ? children(renderState) : children}

			{/* Persistent DragOverlay mounted outside any virtualized list so the
				dragged preview survives list virtualization. */}
			<DragOverlay>
				{activeDrag ? (
					<div
						data-testid="drag-overlay"
						className="rounded-xl border border-vscode-focusBorder bg-vscode-editor-background px-3 py-2 shadow-lg opacity-90 max-w-xs truncate">
						{overlayLabel ?? ""}
					</div>
				) : null}
			</DragOverlay>

			{/* Controlled folder-name dialog for task-on-task drops. */}
			<FolderNameDialog
				open={pendingFolderDraft !== null}
				onOpenChange={(open) => {
					if (!open) handleCancelFolderName()
				}}
				onConfirm={handleConfirmFolderName}
			/>
		</DndContext>
	)
}

TaskOrganizationDndSurface.displayName = "TaskOrganizationDndSurface"
