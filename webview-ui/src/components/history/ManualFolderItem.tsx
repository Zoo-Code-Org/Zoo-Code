import React, { memo, useCallback, useMemo, useState } from "react"
import { useDroppable } from "@dnd-kit/core"
import { ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { StandardTooltip } from "@/components/ui/standard-tooltip"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import type { TaskOrganizationTargetV1 } from "@roo-code/types"

import type { ResolvedTaskUnit } from "./types"
import { PinButton } from "./PinButton"

export interface ManualFolderItemProps {
	folderId: string
	name: string
	/** Count of visible task units inside this folder. */
	unitCount: number
	/** Whether this folder is currently expanded. */
	isExpanded: boolean
	/** Whether this folder is pinned. */
	isPinned: boolean
	/** Whether pinning is currently allowed. */
	canPin: boolean
	/** Callback to toggle expansion. */
	onToggleExpand: () => void
	/** Callback to rename the folder (validated name). */
	onRename: (name: string) => void
	/** Callback to delete the folder. */
	onDelete: () => void
	/** Callback to toggle pin state. */
	onTogglePin: () => void
	/** Whether selection mode is active. When true, edit/pin/options are hidden. */
	isSelectionMode?: boolean
	/** Whether this folder is currently selected in selection mode. */
	isSelected?: boolean
	/** Callback to toggle folder selection in selection mode. */
	onToggleSelection?: (folderId: string, isSelected: boolean) => void
	/** Children to render when expanded. */
	children?: React.ReactNode
	/** Optional className. */
	className?: string
	/** Optional data-testid. */
	"data-testid"?: string
}

const MAX_NAME_LENGTH = 80

function validateFolderName(name: string): { valid: boolean; error?: string } {
	const normalized = name.trim().normalize("NFC")
	if (normalized.length === 0) {
		return { valid: false, error: "history:folderNameRequired" }
	}
	if (normalized.length > MAX_NAME_LENGTH) {
		return { valid: false, error: "history:folderNameTooLong" }
	}
	if (/[\p{C}]/u.test(normalized)) {
		return { valid: false, error: "history:folderNameInvalidChars" }
	}
	return { valid: true }
}

/**
 * Render a manual folder header with inline rename, pin, expand, grip, and
 * delete controls. The header is a dnd-kit drop target for task/group units.
 */
export const ManualFolderItem: React.FC<ManualFolderItemProps> = ({
	folderId,
	name,
	unitCount,
	isExpanded,
	isPinned,
	canPin,
	onToggleExpand,
	onRename,
	onDelete,
	onTogglePin,
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	children,
	className,
	"data-testid": dataTestId,
}) => {
	const { t } = useAppTranslation()
	const [isEditing, setIsEditing] = useState(false)
	const [editValue, setEditValue] = useState(name)
	const [validationError, setValidationError] = useState<string | null>(null)

	const target: TaskOrganizationTargetV1 = useMemo(() => ({ kind: "folder", folderId }), [folderId])

	const { isOver, setNodeRef } = useDroppable({
		id: `folder-drop-${folderId}`,
		data: { kind: "folder", target, folderId },
		disabled: isEditing || isSelectionMode,
	})

	const startEditing = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			setIsEditing(true)
			setEditValue(name)
			setValidationError(null)
		},
		[name],
	)

	const commitRename = useCallback(() => {
		const result = validateFolderName(editValue)
		if (!result.valid) {
			setValidationError(result.error ?? null)
			return
		}
		onRename(editValue.trim().normalize("NFC"))
		setIsEditing(false)
		setValidationError(null)
	}, [editValue, onRename])

	const cancelRename = useCallback(() => {
		setIsEditing(false)
		setEditValue(name)
		setValidationError(null)
	}, [name])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault()
				commitRename()
			} else if (e.key === "Escape") {
				e.preventDefault()
				cancelRename()
			}
		},
		[commitRename, cancelRename],
	)

	const handleDelete = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			onDelete()
		},
		[onDelete],
	)

	return (
		<div
			ref={setNodeRef}
			data-testid={dataTestId ?? `manual-folder-${folderId}`}
			data-folder-id={folderId}
			data-is-over={isOver ? "true" : "false"}
			className={cn(
				"rounded-xl border border-vscode-panel-border overflow-hidden",
				isOver && "ring-2 ring-vscode-focusBorder",
				className,
			)}>
			<div
				className={cn(
					"flex items-center gap-2 px-3 py-2 cursor-pointer",
					"bg-vscode-editor-background hover:bg-vscode-list-hoverBackground transition-colors",
				)}>
				{/* Selection checkbox (selection mode) */}
				{isSelectionMode && (
					<input
						type="checkbox"
						checked={isSelected}
						aria-label={t("history:selectFolder")}
						data-testid={`folder-select-${folderId}`}
						onClick={(e) => e.stopPropagation()}
						onChange={(e) => onToggleSelection?.(folderId, e.target.checked)}
					/>
				)}

				{/* Expand toggle */}
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={isExpanded ? t("history:collapseFolder") : t("history:expandFolder")}
					onClick={(e) => {
						e.stopPropagation()
						onToggleExpand()
					}}
					data-testid="folder-expand-toggle">
					{isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
				</Button>

				{/* Folder icon */}
				{isExpanded ? (
					<FolderOpen className="size-4 text-vscode-descriptionForeground" />
				) : (
					<Folder className="size-4 text-vscode-descriptionForeground" />
				)}

				{/* Name / inline rename */}
				{isEditing ? (
					<div className="flex-1 min-w-0 flex flex-col gap-1">
						<Input
							autoFocus
							value={editValue}
							onChange={(e) => setEditValue(e.target.value)}
							onKeyDown={handleKeyDown}
							onBlur={commitRename}
							maxLength={MAX_NAME_LENGTH + 1}
							aria-label={t("history:folderNameLabel")}
							data-testid="folder-name-input"
							className="h-7"
						/>
						{validationError && (
							<span className="text-xs text-vscode-errorForeground" data-testid="folder-name-error">
								{t(validationError)}
							</span>
						)}
					</div>
				) : (
					<div className="flex-1 min-w-0 flex items-center gap-2">
						<span className="font-medium truncate" data-testid="folder-name">
							{name}
						</span>
						<span className="text-xs text-vscode-descriptionForeground" data-testid="folder-count">
							{t("history:tasks", { count: unitCount })}
						</span>
					</div>
				)}

				{/* Actions — hidden in selection mode (edit/pin/options disabled) */}
				{!isEditing && !isSelectionMode && (
					<div className="flex items-center gap-0">
						<PinButton
							isPinned={isPinned}
							canPin={canPin}
							onToggle={onTogglePin}
							size="sm"
							data-testid="folder-pin-button"
						/>

						<StandardTooltip content={t("history:renameFolder")}>
							<Button
								variant="ghost"
								size="icon"
								className="size-6"
								aria-label={t("history:renameFolder")}
								onClick={startEditing}
								data-testid="folder-rename-button">
								<Pencil className="size-3.5" />
							</Button>
						</StandardTooltip>

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-6"
									aria-label={t("history:folderOptions")}
									onClick={(e) => e.stopPropagation()}
									data-testid="folder-options-menu">
									<MoreHorizontal className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
								<DropdownMenuItem onClick={startEditing} data-testid="folder-rename-option">
									<Pencil className="size-3.5 mr-2" />
									{t("history:renameFolder")}
								</DropdownMenuItem>
								<DropdownMenuItem
									className="text-vscode-errorForeground focus:text-vscode-errorForeground"
									onClick={handleDelete}
									data-testid="folder-delete-option">
									<Trash2 className="size-3.5 mr-2" />
									{t("history:deleteEmptyFolder")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}
			</div>

			{/* Expanded folder members */}
			{isExpanded && (
				<div
					className="border-t border-vscode-panel-border"
					data-testid="folder-children"
					onClick={(e) => e.stopPropagation()}>
					{children}
				</div>
			)}
		</div>
	)
}

export interface ManualFolderMemberItemProps {
	unit: ResolvedTaskUnit
	folderId: string
	/** Optional children for nested subtask rows. */
	children?: React.ReactNode
	/** Optional className. */
	className?: string
	/** Optional data-testid. */
	"data-testid"?: string
}

/**
 * Droppable wrapper for individual folder members. It lets the user drop other
 * units onto existing members, which results in a new folder containing both.
 */
export const ManualFolderMemberItem: React.FC<ManualFolderMemberItemProps> = ({
	unit,
	folderId,
	children,
	className,
	"data-testid": dataTestId,
}) => {
	const { setNodeRef, isOver } = useDroppable({
		id: `folder-member-drop-${folderId}-${unit.rootTaskId}`,
		data: { kind: "task", target: unit.target, folderId },
	})

	return (
		<div
			ref={setNodeRef}
			data-testid={dataTestId ?? `folder-member-${unit.rootTaskId}`}
			data-is-over={isOver ? "true" : "false"}
			className={cn("relative", isOver && "ring-1 ring-inset ring-vscode-focusBorder", className)}>
			{children}
		</div>
	)
}

export default memo(ManualFolderItem)
