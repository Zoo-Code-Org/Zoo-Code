import React, { memo } from "react"
import { useDraggable, useDroppable } from "@dnd-kit/core"

import { cn } from "@/lib/utils"

import type { DndItemData } from "./useTaskOrganizationDnd"

export interface DraggableTaskEntryProps {
	/** Unique id for the draggable wrapper. */
	id: string
	/** DnD item metadata. */
	dndData: DndItemData
	/** Whether dragging is currently disabled (search/selection/compact). */
	disabled?: boolean
	/** Optional className. */
	className?: string
	/** The wrapped card content (task item or task group). Required. */
	children: React.ReactNode
}

/**
 * Whole-card draggable wrapper. The existing card renderer is passed in as
 * children so this component never re-implements task/group presentation.
 *
 * Drag activation is handled by TaskOrganizationPointerSensor, which rejects
 * pointerdown events landing on interactive descendants (buttons, inputs,
 * links, menu items, etc.) so pin/checkbox/expand/menu/rename/delete
 * controls keep working.
 */
export const DraggableTaskEntry: React.FC<DraggableTaskEntryProps> = ({
	id,
	dndData,
	disabled = false,
	className,
	children,
}) => {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id,
		data: dndData,
		disabled,
	})

	// Expose a droppable zone on the same wrapper with a distinct `drop-` prefix
	// so the DnD controller can treat this entry as a destination too.
	const droppableId = `drop-${id}`
	const { setNodeRef: setDroppableRef } = useDroppable({
		id: droppableId,
		data: dndData,
		disabled,
	})

	const style = transform
		? {
				transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
			}
		: undefined

	// Strip role="button" from attributes to prevent wrapper-level interactive selector matches
	const { role, ...restAttributes } = attributes

	return (
		<div
			ref={(node) => {
				setNodeRef(node)
				setDroppableRef(node)
			}}
			style={style}
			data-testid={`draggable-entry-${id}`}
			data-dragging={isDragging ? "true" : "false"}
			data-droppable-id={droppableId}
			className={cn(
				"relative",
				!disabled && "cursor-grab active:cursor-grabbing",
				isDragging && "opacity-40",
				className,
			)}
			{...restAttributes}
			{...listeners}>
			{children}
		</div>
	)
}

export default memo(DraggableTaskEntry)
