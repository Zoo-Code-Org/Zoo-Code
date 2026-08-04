import { memo, useCallback, useMemo, useState } from "react"
import { useDroppable } from "@dnd-kit/core"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import { useTaskSearch } from "./useTaskSearch"
import { useGroupedTasks } from "./useGroupedTasks"
import type { TaskGroup } from "./types"
import type { TaskOrganizationTargetV1 } from "@roo-code/types"
import TaskGroupItem from "./TaskGroupItem"
import { TaskOrganizationInteractionProvider } from "./TaskOrganizationInteractionContext"
import { useTaskOrganization } from "./TaskOrganizationInteractionContext"
import { TaskOrganizationErrorBoundary } from "./TaskOrganizationErrorBoundary"
import { TaskOrganizationDndSurface } from "./TaskOrganizationDndSurface"
import { DraggableTaskEntry } from "./DraggableTaskEntry"
import { ManualFolderItem, ManualFolderMemberItem } from "./ManualFolderItem"
import {
	buildGroupedOrganizationProjection,
	buildCanonicalTarget,
	resolveOrganizationUnit,
} from "./taskOrganizationModel"
import { PinnedHistoryItem } from "./PinnedHistoryItem"
import { UNFILED_DROP_ZONE_ID } from "./useTaskOrganizationDnd"
import type { ActiveDragState, DndItemData } from "./useTaskOrganizationDnd"

/**
 * Registered Unfiled drop zone for HistoryPreview.
 */
const UnfiledDropZone: React.FC<{ visible: boolean; disabled: boolean }> = ({ visible, disabled }) => {
	const { t } = useAppTranslation()
	const { isOver, setNodeRef } = useDroppable({
		id: UNFILED_DROP_ZONE_ID,
		data: { kind: "unfiled" },
		disabled,
	})

	if (!visible) return null

	return (
		<div
			ref={setNodeRef}
			data-testid="unfiled-drop-zone"
			data-is-over={isOver ? "true" : "false"}
			className={`m-2 rounded-xl border-2 border-dashed px-3 py-3 text-center text-sm transition-colors ${
				isOver
					? "border-vscode-focusBorder bg-vscode-list-hoverBackground text-vscode-foreground"
					: "border-vscode-panel-border text-vscode-descriptionForeground"
			}`}>
			{t("history:dropToRemoveFromFolder")}
		</div>
	)
}

function buildGroupDndData(group: TaskGroup, folderId?: string): DndItemData {
	const rootId = group.parent.id
	const hasChildren = group.subtasks.length > 0
	const target: TaskOrganizationTargetV1 = hasChildren
		? { kind: "autoGroup", rootTaskId: rootId }
		: { kind: "task", taskId: rootId }
	return {
		kind: "task",
		target,
		folderId,
	}
}

/**
 * Inner preview component that renders recent task groups with pin & folder support.
 * Must be rendered inside TaskOrganizationInteractionProvider.
 */
const HistoryPreviewInner = memo(() => {
	const { tasks, searchQuery } = useTaskSearch()
	const { groups, toggleExpand } = useGroupedTasks(tasks, searchQuery)
	const { t } = useAppTranslation()
	const { cwd } = useExtensionState()

	// Task organization context
	const { organization, isPinned, canPin, togglePin, renameFolder, deleteFolder } = useTaskOrganization()

	// Expanded state for manual folders in preview
	const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set())

	const toggleFolderExpand = useCallback((folderId: string) => {
		setExpandedFolderIds((prev) => {
			const next = new Set(prev)
			if (next.has(folderId)) {
				next.delete(folderId)
			} else {
				next.add(folderId)
			}
			return next
		})
	}, [])

	const handleViewAllHistory = () => {
		vscode.postMessage({ type: "switchTab", tab: "history" })
	}

	const projection = useMemo(
		() => buildGroupedOrganizationProjection(organization, groups, tasks, cwd),
		[organization, groups, tasks, cwd],
	)

	// Pinned shortcuts section, mirroring HistoryView's pinned header: pins
	// follow the same workspace scoping as the projection (a folder whose
	// members all belong to another workspace is not visible here; task pins
	// resolve to their canonical group root within the visible tasks).
	const visiblePins = useMemo(
		() =>
			organization.pins.filter((pin) => {
				const target = pin.target
				if (target.kind === "folder") {
					return projection.folderProjections.some((p) => p.folderId === target.folderId)
				}
				const rootId = target.kind === "task" ? buildCanonicalTarget(target.taskId, groups) : target.rootTaskId
				return tasks.some((x) => x.id === rootId)
			}),
		[organization.pins, projection.folderProjections, groups, tasks],
	)

	// Resolve a human-readable label for the drag overlay.
	const resolveDragLabel = useCallback(
		(activeDrag: ActiveDragState): React.ReactNode => {
			const data = activeDrag.data
			if (data.kind === "folder") {
				const folder = organization.folders.find((f) => f.folderId === data.folderId)
				return folder?.name ?? data.folderId ?? null
			}
			const target = data.target
			if (target.kind === "task") {
				const task = tasks.find((x) => x.id === target.taskId)
				return task?.task ?? target.taskId
			}
			if (target.kind === "autoGroup") {
				const task = tasks.find((x) => x.id === target.rootTaskId)
				return task?.task ?? target.rootTaskId
			}
			if (target.kind === "folder") {
				const folder = organization.folders.find((f) => f.folderId === target.folderId)
				return folder?.name ?? target.folderId
			}
			return null
		},
		[organization.folders, tasks],
	)

	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center justify-between mt-4 mb-2">
				<h2 className="font-semibold text-lg grow m-0">{t("history:recentTasks")}</h2>
				<button
					onClick={handleViewAllHistory}
					className="text-base text-vscode-descriptionForeground hover:text-vscode-textLink-foreground transition-colors cursor-pointer"
					aria-label={t("history:viewAllHistory")}>
					{t("history:viewAllHistory")}
				</button>
			</div>
			<TaskOrganizationDndSurface enabled resolveDragLabel={resolveDragLabel}>
				{({ isFolderMemberDragActive }) => (
					<div className="flex flex-col gap-1">
						<UnfiledDropZone visible={isFolderMemberDragActive} disabled={false} />

						{/* Pinned shortcuts (same section as History's pinned header) */}
						{visiblePins.length > 0 && (
							<div className="flex flex-col gap-1 m-2" data-testid="preview-pinned-section">
								{visiblePins.map((pin) => {
									const target = pin.target
									if (target.kind === "folder") {
										const folder = organization.folders.find((f) => f.folderId === target.folderId)
										return (
											<PinnedHistoryItem
												key={`preview-pin-folder-${target.folderId}`}
												folderName={folder?.name ?? target.folderId}
												isPinned
												canPin={canPin}
												onTogglePin={() => void togglePin(target)}
												data-testid={`preview-pinned-folder-${target.folderId}`}
											/>
										)
									}
									const rootId =
										target.kind === "task"
											? buildCanonicalTarget(target.taskId, groups)
											: target.rootTaskId
									const unit = resolveOrganizationUnit(rootId, tasks)
									const rootTask = tasks.find((x) => x.id === unit.rootTaskId)
									return (
										<PinnedHistoryItem
											key={`preview-pin-unit-${unit.rootTaskId}`}
											unit={unit}
											label={rootTask?.task ?? unit.rootTaskId}
											isPinned
											canPin={canPin}
											onTogglePin={() => void togglePin(target)}
											data-testid={`preview-pinned-unit-${unit.rootTaskId}`}
										/>
									)
								})}
							</div>
						)}

						{/* Manual Folders */}
						{projection.folderProjections.map((folder) => (
							<ManualFolderItem
								key={folder.folderId}
								folderId={folder.folderId}
								name={folder.folderName}
								unitCount={folder.members.length}
								isExpanded={expandedFolderIds.has(folder.folderId)}
								isPinned={isPinned({ kind: "folder", folderId: folder.folderId })}
								canPin={canPin}
								onToggleExpand={() => toggleFolderExpand(folder.folderId)}
								onRename={(name) => renameFolder(folder.folderId, name)}
								onDelete={() => deleteFolder(folder.folderId)}
								onTogglePin={() => togglePin({ kind: "folder", folderId: folder.folderId })}>
								{expandedFolderIds.has(folder.folderId) &&
									folder.members.map((group) => {
										const dndData = buildGroupDndData(group, folder.folderId)
										const unit = resolveOrganizationUnit(group.parent.id, tasks)
										return (
											<ManualFolderMemberItem
												key={group.parent.id}
												unit={unit}
												folderId={folder.folderId}>
												<DraggableTaskEntry id={`preview-${group.parent.id}`} dndData={dndData}>
													<TaskGroupItem
														group={group}
														variant="compact"
														onToggleExpand={() => toggleExpand(group.parent.id)}
														onToggleSubtaskExpand={toggleExpand}
														showPin
														isPinned={isPinned({ kind: "task", taskId: group.parent.id })}
														canPin={canPin}
														onTogglePin={() =>
															togglePin({ kind: "task", taskId: group.parent.id })
														}
													/>
												</DraggableTaskEntry>
											</ManualFolderMemberItem>
										)
									})}
							</ManualFolderItem>
						))}

						{/* Unfiled Tasks (up to 4) */}
						{projection.unfiledGroups.slice(0, 4).map((group) => {
							const dndData = buildGroupDndData(group)
							return (
								<DraggableTaskEntry
									key={group.parent.id}
									id={`preview-${group.parent.id}`}
									dndData={dndData}>
									<TaskGroupItem
										group={group}
										variant="compact"
										onToggleExpand={() => toggleExpand(group.parent.id)}
										onToggleSubtaskExpand={toggleExpand}
										showPin
										isPinned={isPinned({ kind: "task", taskId: group.parent.id })}
										canPin={canPin}
										onTogglePin={() => togglePin({ kind: "task", taskId: group.parent.id })}
									/>
								</DraggableTaskEntry>
							)
						})}
					</div>
				)}
			</TaskOrganizationDndSurface>
		</div>
	)
})

HistoryPreviewInner.displayName = "HistoryPreviewInner"

/**
 * Baseline preview renderer used as the ErrorBoundary fallback.
 *
 * Consumes only the original `useTaskSearch` + `useGroupedTasks` pipeline
 * and intentionally avoids `useTaskOrganization` (no pins). When the
 * task-organization feature throws, this component mounts in its place so
 * the Welcome screen still renders the original first four compact groups.
 */
const HistoryPreviewBaselineFallback = memo(() => {
	const { tasks, searchQuery } = useTaskSearch()
	const { groups, toggleExpand } = useGroupedTasks(tasks, searchQuery)
	const { t } = useAppTranslation()

	const handleViewAllHistory = () => {
		vscode.postMessage({ type: "switchTab", tab: "history" })
	}

	// Show up to 4 groups (parent + subtasks count as 1 block)
	const displayGroups = groups.slice(0, 4)

	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center justify-between mt-4 mb-2">
				<h2 className="font-semibold text-lg grow m-0">{t("history:recentTasks")}</h2>
				<button
					onClick={handleViewAllHistory}
					className="text-base text-vscode-descriptionForeground hover:text-vscode-textLink-foreground transition-colors cursor-pointer"
					aria-label={t("history:viewAllHistory")}>
					{t("history:viewAllHistory")}
				</button>
			</div>
			{displayGroups.length !== 0 && (
				<>
					{displayGroups.map((group) => (
						<TaskGroupItem
							key={group.parent.id}
							group={group}
							variant="compact"
							onToggleExpand={() => toggleExpand(group.parent.id)}
							onToggleSubtaskExpand={toggleExpand}
						/>
					))}
				</>
			)}
		</div>
	)
})

HistoryPreviewBaselineFallback.displayName = "HistoryPreviewBaselineFallback"

/**
 * History preview with task organization (pin & folder DnD) support.
 *
 * Wraps the inner preview with an ErrorBoundary so that a failure in the
 * pin/folder feature never breaks the existing rendering. On failure the
 * boundary swaps in the baseline renderer so the original first four
 * compact groups remain visible.
 */
const HistoryPreview = () => {
	return (
		<TaskOrganizationErrorBoundary fallback={<HistoryPreviewBaselineFallback />}>
			<TaskOrganizationInteractionProvider>
				<HistoryPreviewInner />
			</TaskOrganizationInteractionProvider>
		</TaskOrganizationErrorBoundary>
	)
}

export default memo(HistoryPreview)
