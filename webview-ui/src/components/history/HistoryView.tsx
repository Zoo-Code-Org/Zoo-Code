import React, { memo, useCallback, useMemo, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { DeleteTaskDialog } from "./DeleteTaskDialog"
import { BatchDeleteTaskDialog } from "./BatchDeleteTaskDialog"
import { DeleteFoldersDialog } from "./DeleteFoldersDialog"
import { FolderNameDialog } from "./FolderNameDialog"
import { Virtuoso } from "react-virtuoso"
import { useDroppable } from "@dnd-kit/core"

import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	Button,
	Checkbox,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StandardTooltip,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"

import { Tab, TabContent, TabHeader } from "../common/Tab"
import { useTaskSearch } from "./useTaskSearch"
import { useGroupedTasks } from "./useGroupedTasks"
import { countAllSubtasks } from "./types"
import type { TaskGroup } from "./types"
import type { TaskOrganizationTargetV1 } from "@roo-code/types"
import TaskItem from "./TaskItem"
import TaskGroupItem from "./TaskGroupItem"
import { TaskOrganizationInteractionProvider } from "./TaskOrganizationInteractionContext"
import { useTaskOrganization } from "./TaskOrganizationInteractionContext"
import { TaskOrganizationErrorBoundary } from "./TaskOrganizationErrorBoundary"
import { DraggableTaskEntry } from "./DraggableTaskEntry"
import { ManualFolderItem, ManualFolderMemberItem } from "./ManualFolderItem"
import { PinnedHistoryItem } from "./PinnedHistoryItem"
import { TaskOrganizationDndSurface } from "./TaskOrganizationDndSurface"
import {
	buildGroupedOrganizationProjection,
	resolveOrganizationUnit,
	buildCanonicalTarget,
} from "./taskOrganizationModel"
import { UNFILED_DROP_ZONE_ID } from "./useTaskOrganizationDnd"
import type { ActiveDragState, DndItemData } from "./useTaskOrganizationDnd"

type HistoryViewProps = {
	onDone: () => void
}

type SortOption = "newest" | "oldest" | "mostExpensive" | "mostTokens" | "mostRelevant"

/**
 * Builds the DndItemData for a canonical task group row.
 */
function buildGroupDndData(group: TaskGroup, groups: TaskGroup[], folderId?: string): DndItemData {
	const rootId = group.parent.id
	const hasChildren = group.subtasks.length > 0
	const target: TaskOrganizationTargetV1 = hasChildren
		? { kind: "autoGroup", rootTaskId: rootId }
		: { kind: "task", taskId: rootId }
	void groups
	return {
		kind: "task",
		target,
		folderId,
	}
}

/**
 * Registered Unfiled drop zone, rendered only while a folder member is being dragged.
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

/**
 * Inner component that renders the full history list.
 * Must be rendered inside TaskOrganizationInteractionProvider.
 */
const HistoryViewInner = memo(({ onDone }: HistoryViewProps) => {
	const {
		tasks,
		searchQuery,
		setSearchQuery,
		sortOption,
		setSortOption,
		setLastNonRelevantSort,
		showAllWorkspaces,
		setShowAllWorkspaces,
	} = useTaskSearch()
	const { t } = useAppTranslation()
	const { cwd } = useExtensionState()

	// Use grouped tasks hook
	const { groups, flatTasks, toggleExpand, isSearchMode } = useGroupedTasks(tasks, searchQuery)

	// Task organization context (pins, folders, mutations)
	const {
		organization,
		isPinned,
		canPin,
		togglePin,
		renameFolder,
		deleteFolder,
		createFolderFromSelection,
		deleteFolders,
	} = useTaskOrganization()

	const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
	const [deleteSubtaskCount, setDeleteSubtaskCount] = useState<number>(0)
	const [isSelectionMode, setIsSelectionMode] = useState(false)
	const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
	const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([])
	const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState<boolean>(false)
	const [showDeleteFoldersDialog, setShowDeleteFoldersDialog] = useState<boolean>(false)
	const [showSelectionFolderNameDialog, setShowSelectionFolderNameDialog] = useState<boolean>(false)
	const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set())

	// DnD is enabled only in the grouped (non-search, non-selection) path.
	const isDndEnabled = !isSearchMode && !isSelectionMode

	// Compute the grouped projection around the existing groups.
	const projection = useMemo(
		() => buildGroupedOrganizationProjection(organization, groups, tasks, showAllWorkspaces ? undefined : cwd),
		[organization, groups, tasks, showAllWorkspaces, cwd],
	)

	// Get subtask count for a task (recursive total)
	const getSubtaskCount = useMemo(() => {
		const countMap = new Map<string, number>()
		for (const group of groups) {
			countMap.set(group.parent.id, countAllSubtasks(group.subtasks))
		}
		return (taskId: string) => countMap.get(taskId) || 0
	}, [groups])

	// Handle delete with subtask count
	const handleDelete = (taskId: string) => {
		setDeleteTaskId(taskId)
		setDeleteSubtaskCount(getSubtaskCount(taskId))
	}

	// Toggle selection mode
	const toggleSelectionMode = () => {
		setIsSelectionMode((prev) => !prev)
		setSelectedTaskIds([])
		setSelectedFolderIds([])
	}

	// Toggle selection for a single task
	const toggleTaskSelection = (taskId: string, isSelected: boolean) => {
		if (isSelected) {
			setSelectedTaskIds((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]))
		} else {
			setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
		}
	}

	// Toggle select all tasks
	const toggleSelectAll = (selectAll: boolean) => {
		if (selectAll) {
			setSelectedTaskIds(tasks.map((task) => task.id))
		} else {
			setSelectedTaskIds([])
			setSelectedFolderIds([])
		}
	}

	// Handle batch delete button click
	const handleBatchDelete = () => {
		if (selectedTaskIds.length > 0) {
			setShowBatchDeleteDialog(true)
		}
	}

	// Toggle folder selection in selection mode
	const toggleFolderSelection = useCallback((folderId: string, isSelected: boolean) => {
		setSelectedFolderIds((prev) =>
			isSelected ? (prev.includes(folderId) ? prev : [...prev, folderId]) : prev.filter((id) => id !== folderId),
		)
	}, [])

	// Compute canonical task targets for the current task selection. Each
	// selected root id maps to a task or autoGroup target; selecting a parent
	// plus its child collapses to the single parent canonical unit because
	// buildCanonicalTarget returns the group root id.
	const selectedTaskTargets = useMemo<TaskOrganizationTargetV1[]>(() => {
		const seen = new Set<string>()
		const targets: TaskOrganizationTargetV1[] = []
		for (const taskId of selectedTaskIds) {
			const rootId = buildCanonicalTarget(taskId, groups)
			if (seen.has(rootId)) continue
			seen.add(rootId)
			const group = groups.find((g) => g.parent.id === rootId)
			if (group && group.subtasks.length > 0) {
				targets.push({ kind: "autoGroup", rootTaskId: rootId })
			} else {
				targets.push({ kind: "task", taskId: rootId })
			}
		}
		return targets
	}, [selectedTaskIds, groups])

	// Create Folder is enabled when at least two distinct canonical units are
	// selected (tasks/groups and/or folders combined).
	// Architect spec Section 1.6: create-folder requires at least two canonical
	// task units and is disabled while any folder is selected.
	const canCreateFolderFromSelection = selectedTaskTargets.length >= 2 && selectedFolderIds.length === 0

	const handleCreateFolderFromSelection = useCallback(() => {
		if (!canCreateFolderFromSelection) return
		setShowSelectionFolderNameDialog(true)
	}, [canCreateFolderFromSelection])

	const handleConfirmSelectionFolderName = useCallback(
		(name: string) => {
			const targets: TaskOrganizationTargetV1[] = [
				...selectedTaskTargets,
				...selectedFolderIds.map((folderId) => ({ kind: "folder", folderId }) as TaskOrganizationTargetV1),
			]
			void createFolderFromSelection(name, targets).then((result) => {
				if (result.success) {
					setSelectedTaskIds([])
					setSelectedFolderIds([])
				}
			})
		},
		[selectedTaskTargets, selectedFolderIds, createFolderFromSelection],
	)

	const handleDeleteFoldersClick = useCallback(() => {
		if (selectedFolderIds.length > 0) {
			setShowDeleteFoldersDialog(true)
		}
	}, [selectedFolderIds.length])

	const handleConfirmDeleteFolders = useCallback(() => {
		void deleteFolders(selectedFolderIds).then((result) => {
			if (result.success) {
				setSelectedFolderIds([])
			}
		})
	}, [deleteFolders, selectedFolderIds])

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

	// Expanded state for pinned folder shortcut cards (inline member list).
	const [expandedPinnedFolderIds, setExpandedPinnedFolderIds] = useState<Set<string>>(new Set())

	const togglePinnedFolderExpand = useCallback((folderId: string) => {
		setExpandedPinnedFolderIds((prev) => {
			const next = new Set(prev)
			if (next.has(folderId)) {
				next.delete(folderId)
			} else {
				next.add(folderId)
			}
			return next
		})
	}, [])

	// Resolve the active drag's source unit for the DragOverlay label.
	// History owns the data (tasks, folder names) needed for a readable label;
	// the shared surface owns the overlay itself.
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

	// Render the additive pinned section (shortcut cards) above the list.
	const renderPinnedHeader = () => {
		// When workspace filtering is active, exclude pins whose targets
		// resolve to tasks that don't exist in the current workspace.
		// Folder pins follow the projection's workspace scoping: a folder
		// whose members all belong to another workspace is not visible here.
		const visiblePins = showAllWorkspaces
			? organization.pins
			: organization.pins.filter((pin) => {
					const target = pin.target
					if (target.kind === "folder") {
						return projection.folderProjections.some((p) => p.folderId === target.folderId)
					}
					const rootId =
						target.kind === "task" ? buildCanonicalTarget(target.taskId, groups) : target.rootTaskId
					return tasks.some((x) => x.id === rootId)
				})

		if (visiblePins.length === 0) return null
		return (
			<div className="flex flex-col gap-1 m-2" data-testid="pinned-section">
				{visiblePins.map((pin) => {
					const target = pin.target
					if (target.kind === "folder") {
						const folder = organization.folders.find((f) => f.folderId === target.folderId)
						const folderProjection = projection.folderProjections.find(
							(p) => p.folderId === target.folderId,
						)
						const memberGroups = folderProjection?.members ?? []
						return (
							<PinnedHistoryItem
								key={`pin-folder-${target.folderId}`}
								folderName={folder?.name ?? target.folderId}
								isPinned
								canPin={canPin}
								onTogglePin={() => void togglePin(target)}
								isExpanded={expandedPinnedFolderIds.has(target.folderId)}
								onClick={() => togglePinnedFolderExpand(target.folderId)}
								data-testid={`pinned-folder-${target.folderId}`}>
								{memberGroups.length > 0
									? memberGroups.map((memberGroup) => {
											const rootId = memberGroup.parent.id
											return (
												<TaskGroupItem
													key={rootId}
													group={memberGroup}
													variant="compact"
													showWorkspace={showAllWorkspaces}
													isSelectionMode={isSelectionMode}
													isSelected={selectedTaskIds.includes(rootId)}
													onToggleSelection={toggleTaskSelection}
													onDelete={handleDelete}
													onToggleExpand={() => toggleExpand(rootId)}
													onToggleSubtaskExpand={toggleExpand}
													showPin
													isPinned={isPinned({ kind: "task", taskId: rootId })}
													canPin={canPin}
													onTogglePin={() => void togglePin({ kind: "task", taskId: rootId })}
												/>
											)
										})
									: undefined}
							</PinnedHistoryItem>
						)
					}
					const rootId =
						target.kind === "task" ? buildCanonicalTarget(target.taskId, groups) : target.rootTaskId
					const unit = resolveOrganizationUnit(rootId, tasks)
					const rootTask = tasks.find((x) => x.id === unit.rootTaskId)
					return (
						<PinnedHistoryItem
							key={`pin-unit-${unit.rootTaskId}`}
							unit={unit}
							label={rootTask?.task ?? unit.rootTaskId}
							isPinned
							canPin={canPin}
							onTogglePin={() => void togglePin(target)}
							data-testid={`pinned-unit-${unit.rootTaskId}`}
						/>
					)
				})}
			</div>
		)
	}

	// Render the additive manual-folder section.
	const renderFolderSection = () => {
		if (projection.folderProjections.length === 0) return null
		return (
			<div className="flex flex-col gap-1 m-2" data-testid="folder-section">
				{projection.folderProjections.map((folderProjection) => {
					const folderId = folderProjection.folderId
					const isExpanded = expandedFolderIds.has(folderId)
					const folderTarget: TaskOrganizationTargetV1 = { kind: "folder", folderId }
					const unitCount = folderProjection.members.length + folderProjection.hiddenCount
					return (
						<ManualFolderItem
							key={folderId}
							folderId={folderId}
							name={folderProjection.folderName}
							unitCount={unitCount}
							isExpanded={isExpanded}
							isPinned={isPinned(folderTarget)}
							canPin={canPin}
							onToggleExpand={() => toggleFolderExpand(folderId)}
							onRename={(name) => void renameFolder(folderId, name)}
							onDelete={() => void deleteFolder(folderId)}
							onTogglePin={() => void togglePin(folderTarget)}
							isSelectionMode={isSelectionMode}
							isSelected={selectedFolderIds.includes(folderId)}
							onToggleSelection={toggleFolderSelection}
							data-testid={`manual-folder-${folderId}`}>
							{folderProjection.members.map((memberGroup) => {
								const rootId = memberGroup.parent.id
								const dndData = buildGroupDndData(memberGroup, groups, folderId)
								const unit = resolveOrganizationUnit(rootId, tasks)
								return (
									<ManualFolderMemberItem
										key={rootId}
										unit={unit}
										folderId={folderId}
										data-testid={`folder-member-${rootId}`}>
										<DraggableTaskEntry
											id={`folder-member-${folderId}-${rootId}`}
											dndData={dndData}
											disabled={!isDndEnabled}
											className="m-2">
											<TaskGroupItem
												group={memberGroup}
												variant="full"
												showWorkspace={showAllWorkspaces}
												isSelectionMode={isSelectionMode}
												isSelected={selectedTaskIds.includes(rootId)}
												onToggleSelection={toggleTaskSelection}
												onDelete={handleDelete}
												onToggleExpand={() => toggleExpand(rootId)}
												onToggleSubtaskExpand={toggleExpand}
												showPin
												isPinned={isPinned({ kind: "task", taskId: rootId })}
												canPin={canPin}
												onTogglePin={() => void togglePin({ kind: "task", taskId: rootId })}
											/>
										</DraggableTaskEntry>
									</ManualFolderMemberItem>
								)
							})}
						</ManualFolderItem>
					)
				})}
			</div>
		)
	}

	return (
		<Tab>
			<TabHeader className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							className="px-1.5 -ml-2"
							onClick={onDone}
							aria-label={t("history:done")}
							data-testid="history-done-button">
							<ArrowLeft />
							<span className="sr-only">{t("history:done")}</span>
						</Button>
						<h3 className="text-vscode-foreground m-0">{t("history:history")}</h3>
					</div>
					<StandardTooltip
						content={
							isSelectionMode ? `${t("history:exitSelectionMode")}` : `${t("history:enterSelectionMode")}`
						}>
						<Button
							variant={isSelectionMode ? "primary" : "secondary"}
							onClick={toggleSelectionMode}
							data-testid="toggle-selection-mode-button">
							<span
								className={`codicon ${isSelectionMode ? "codicon-check-all" : "codicon-checklist"} mr-1`}
							/>
							{isSelectionMode ? t("history:exitSelection") : t("history:selectionMode")}
						</Button>
					</StandardTooltip>
				</div>
				<div className="flex flex-col gap-2">
					<VSCodeTextField
						className="w-full"
						placeholder={t("history:searchPlaceholder")}
						value={searchQuery}
						data-testid="history-search-input"
						onInput={(e) => {
							const newValue = (e.target as HTMLInputElement)?.value
							setSearchQuery(newValue)
							if (newValue && !searchQuery && sortOption !== "mostRelevant") {
								setLastNonRelevantSort(sortOption)
								setSortOption("mostRelevant")
							}
						}}>
						<div slot="start" className="codicon codicon-search mt-0.5 opacity-80 text-sm!" />
						{searchQuery && (
							<div
								className="input-icon-button codicon codicon-close flex justify-center items-center h-full"
								aria-label="Clear search"
								onClick={() => setSearchQuery("")}
								slot="end"
							/>
						)}
					</VSCodeTextField>
					<div className="flex gap-2">
						<Select
							value={showAllWorkspaces ? "all" : "current"}
							onValueChange={(value) => setShowAllWorkspaces(value === "all")}>
							<SelectTrigger className="flex-1">
								<SelectValue>
									{t("history:workspace.prefix")}{" "}
									{t(`history:workspace.${showAllWorkspaces ? "all" : "current"}`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="current">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-folder" />
										{t("history:workspace.current")}
									</div>
								</SelectItem>
								<SelectItem value="all">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-folder-opened" />
										{t("history:workspace.all")}
									</div>
								</SelectItem>
							</SelectContent>
						</Select>
						<Select value={sortOption} onValueChange={(value) => setSortOption(value as SortOption)}>
							<SelectTrigger className="flex-1">
								<SelectValue>
									{t("history:sort.prefix")} {t(`history:sort.${sortOption}`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="newest" data-testid="select-newest">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-arrow-down" />
										{t("history:newest")}
									</div>
								</SelectItem>
								<SelectItem value="oldest" data-testid="select-oldest">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-arrow-up" />
										{t("history:oldest")}
									</div>
								</SelectItem>
								<SelectItem value="mostExpensive" data-testid="select-most-expensive">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-credit-card" />
										{t("history:mostExpensive")}
									</div>
								</SelectItem>
								<SelectItem value="mostTokens" data-testid="select-most-tokens">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-symbol-numeric" />
										{t("history:mostTokens")}
									</div>
								</SelectItem>
								<SelectItem
									value="mostRelevant"
									disabled={!searchQuery}
									data-testid="select-most-relevant">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-search" />
										{t("history:mostRelevant")}
									</div>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{/* Select all & Quick Actions toolbar in selection mode */}
					{isSelectionMode && tasks.length > 0 && (
						<div className="flex flex-wrap items-center justify-between gap-2 py-1 border-t border-vscode-panel-border mt-1 pt-1.5">
							<div className="flex items-center gap-2">
								<Checkbox
									checked={tasks.length > 0 && selectedTaskIds.length === tasks.length}
									onCheckedChange={(checked) => toggleSelectAll(checked === true)}
									variant="description"
								/>
								<span className="text-vscode-foreground text-xs">
									{selectedTaskIds.length === tasks.length
										? t("history:deselectAll")
										: t("history:selectAll")}
								</span>
								<span className="text-vscode-descriptionForeground text-xs">
									(
									{t("history:selectedItems", {
										selected: selectedTaskIds.length,
										total: tasks.length,
									})}
									)
								</span>
							</div>

							<div className="flex items-center gap-1">
								<StandardTooltip content={t("history:createFolderFromSelection")}>
									<Button
										variant="secondary"
										size="sm"
										className="h-7 text-xs px-2 flex items-center gap-1"
										onClick={handleCreateFolderFromSelection}
										disabled={!canCreateFolderFromSelection}
										data-testid="header-create-folder-button">
										<span className="codicon codicon-folder-active" />
										<span>{t("history:createFolder")}</span>
									</Button>
								</StandardTooltip>

								{selectedFolderIds.length > 0 && (
									<StandardTooltip content={t("history:deleteSelectedFolders")}>
										<Button
											variant="secondary"
											size="sm"
											className="h-7 text-xs px-2 flex items-center gap-1 text-vscode-errorForeground"
											onClick={handleDeleteFoldersClick}
											data-testid="header-delete-folders-button">
											<span className="codicon codicon-folder" />
											<span className="codicon codicon-trash" />
										</Button>
									</StandardTooltip>
								)}

								<StandardTooltip content={t("history:deleteSelected")}>
									<Button
										variant="primary"
										size="sm"
										className="h-7 text-xs px-2 flex items-center gap-1"
										onClick={handleBatchDelete}
										disabled={selectedTaskIds.length === 0}
										data-testid="header-delete-selected-button">
										<span className="codicon codicon-trash" />
										<span>{t("history:delete")}</span>
									</Button>
								</StandardTooltip>
							</div>
						</div>
					)}
				</div>
			</TabHeader>

			<TabContent className="px-2 py-0">
				{isSearchMode && flatTasks ? (
					// Search mode: flat list with subtask prefix (no DnD, no folder UI)
					<Virtuoso
						className="flex-1 overflow-y-scroll"
						data={flatTasks}
						data-testid="virtuoso-container"
						initialTopMostItemIndex={0}
						components={{
							List: React.forwardRef((props, ref) => (
								<div {...props} ref={ref} data-testid="virtuoso-item-list" />
							)),
						}}
						itemContent={(_index, item) => (
							<TaskItem
								key={item.id}
								item={item}
								variant="full"
								showWorkspace={showAllWorkspaces}
								isSelectionMode={isSelectionMode}
								isSelected={selectedTaskIds.includes(item.id)}
								onToggleSelection={toggleTaskSelection}
								onDelete={handleDelete}
								showPin
								isPinned={isPinned({ kind: "task", taskId: item.id })}
								canPin={canPin}
								onTogglePin={() => togglePin({ kind: "task", taskId: item.id })}
								className="m-2"
							/>
						)}
					/>
				) : (
					// Grouped mode: additive organization layer wraps the existing
					// grouped Virtuoso. The Virtuoso data remains TaskGroup[].
					<TaskOrganizationDndSurface enabled={isDndEnabled} resolveDragLabel={resolveDragLabel}>
						{({ isFolderMemberDragActive }) => (
							<div className="h-full flex flex-col overflow-hidden" data-testid="task-org-dnd-layer">
								{renderPinnedHeader()}
								{renderFolderSection()}
								<Virtuoso
									className="flex-1 overflow-y-scroll"
									data={projection.unfiledGroups}
									data-testid="virtuoso-container"
									initialTopMostItemIndex={0}
									components={{
										List: React.forwardRef((props, ref) => (
											<div {...props} ref={ref} data-testid="virtuoso-item-list" />
										)),
									}}
									itemContent={(_index, group) => {
										const rootId = group.parent.id
										const dndData = buildGroupDndData(group, groups)
										return (
											<DraggableTaskEntry
												key={rootId}
												id={`unfiled-unit-${rootId}`}
												dndData={dndData}
												disabled={!isDndEnabled}
												className="m-2">
												<TaskGroupItem
													group={group}
													variant="full"
													showWorkspace={showAllWorkspaces}
													isSelectionMode={isSelectionMode}
													isSelected={selectedTaskIds.includes(rootId)}
													onToggleSelection={toggleTaskSelection}
													onDelete={handleDelete}
													onToggleExpand={() => toggleExpand(rootId)}
													onToggleSubtaskExpand={toggleExpand}
													showPin
													isPinned={isPinned({ kind: "task", taskId: rootId })}
													canPin={canPin}
													onTogglePin={() => void togglePin({ kind: "task", taskId: rootId })}
												/>
											</DraggableTaskEntry>
										)
									}}
								/>
								<UnfiledDropZone visible={isFolderMemberDragActive} disabled={!isDndEnabled} />
							</div>
						)}
					</TaskOrganizationDndSurface>
				)}
			</TabContent>

			{/* Fixed action bar at bottom - shown in selection mode when items are selected */}
			{isSelectionMode && (selectedTaskIds.length > 0 || selectedFolderIds.length > 0) && (
				<div
					className="fixed bottom-0 left-0 right-2 bg-vscode-editor-background border-t border-vscode-panel-border p-2 flex flex-wrap justify-between items-center gap-2"
					data-testid="selection-action-bar">
					<div className="text-vscode-foreground text-xs">
						{t("history:selectedItems", { selected: selectedTaskIds.length, total: tasks.length })}
						{selectedFolderIds.length > 0 && (
							<span
								className="ml-2 text-vscode-descriptionForeground"
								data-testid="selected-folder-count">
								{t("history:selectedFolders", { count: selectedFolderIds.length })}
							</span>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setSelectedTaskIds([])
								setSelectedFolderIds([])
							}}>
							{t("history:clearSelection")}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={handleCreateFolderFromSelection}
							disabled={!canCreateFolderFromSelection}
							data-testid="create-folder-from-selection-button">
							{t("history:createFolderFromSelection")}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={handleDeleteFoldersClick}
							disabled={selectedFolderIds.length === 0}
							data-testid="delete-folders-button">
							{t("history:deleteSelectedFolders")}
						</Button>
						<Button
							variant="primary"
							size="sm"
							onClick={handleBatchDelete}
							disabled={selectedTaskIds.length === 0}>
							{t("history:deleteSelected")}
						</Button>
					</div>
				</div>
			)}

			{/* Delete dialog */}
			{deleteTaskId && (
				<DeleteTaskDialog
					taskId={deleteTaskId}
					subtaskCount={deleteSubtaskCount}
					onOpenChange={(open) => {
						if (!open) {
							setDeleteTaskId(null)
							setDeleteSubtaskCount(0)
						}
					}}
					open
				/>
			)}

			{/* Batch delete dialog */}
			{showBatchDeleteDialog && (
				<BatchDeleteTaskDialog
					taskIds={selectedTaskIds}
					open={showBatchDeleteDialog}
					onOpenChange={(open) => {
						if (!open) {
							setShowBatchDeleteDialog(false)
							setSelectedTaskIds([])
							setSelectedFolderIds([])
							setIsSelectionMode(false)
						}
					}}
				/>
			)}

			{/* Selection-mode folder creation dialog (reuses FolderNameDialog) */}
			{showSelectionFolderNameDialog && (
				<FolderNameDialog
					open={showSelectionFolderNameDialog}
					onOpenChange={(open) => {
						if (!open) setShowSelectionFolderNameDialog(false)
					}}
					onConfirm={handleConfirmSelectionFolderName}
				/>
			)}

			{/* Selection-mode folder deletion confirmation */}
			{showDeleteFoldersDialog && (
				<DeleteFoldersDialog
					folderCount={selectedFolderIds.length}
					open={showDeleteFoldersDialog}
					onOpenChange={(open) => {
						if (!open) setShowDeleteFoldersDialog(false)
					}}
					onConfirm={handleConfirmDeleteFolders}
				/>
			)}
		</Tab>
	)
})

HistoryViewInner.displayName = "HistoryViewInner"

/**
 * Baseline history renderer used as the ErrorBoundary fallback.
 *
 * Consumes only the original grouped/search pipeline (`useTaskSearch` +
 * `useGroupedTasks`) and intentionally avoids `useTaskOrganization`, DnD,
 * pins, and folders. When the task-organization feature throws, this
 * component mounts in its place so the user still sees task cards,
 * search/sort controls, and selection actions.
 */
const HistoryViewBaselineFallback = ({ onDone }: HistoryViewProps) => {
	const {
		tasks,
		searchQuery,
		setSearchQuery,
		sortOption,
		setSortOption,
		setLastNonRelevantSort,
		showAllWorkspaces,
		setShowAllWorkspaces,
	} = useTaskSearch()
	const { t } = useAppTranslation()

	const { groups, flatTasks, toggleExpand, isSearchMode } = useGroupedTasks(tasks, searchQuery)

	const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
	const [deleteSubtaskCount, setDeleteSubtaskCount] = useState<number>(0)
	const [isSelectionMode, setIsSelectionMode] = useState(false)
	const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
	const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState<boolean>(false)

	const getSubtaskCount = useMemo(() => {
		const countMap = new Map<string, number>()
		for (const group of groups) {
			countMap.set(group.parent.id, countAllSubtasks(group.subtasks))
		}
		return (taskId: string) => countMap.get(taskId) || 0
	}, [groups])

	const handleDelete = (taskId: string) => {
		setDeleteTaskId(taskId)
		setDeleteSubtaskCount(getSubtaskCount(taskId))
	}

	const toggleSelectionMode = () => {
		setIsSelectionMode(!isSelectionMode)
		if (isSelectionMode) {
			setSelectedTaskIds([])
		}
	}

	const toggleTaskSelection = (taskId: string, isSelected: boolean) => {
		if (isSelected) {
			setSelectedTaskIds((prev) => [...prev, taskId])
		} else {
			setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
		}
	}

	const toggleSelectAll = (selectAll: boolean) => {
		if (selectAll) {
			setSelectedTaskIds(tasks.map((task) => task.id))
		} else {
			setSelectedTaskIds([])
		}
	}

	const handleBatchDelete = () => {
		if (selectedTaskIds.length > 0) {
			setShowBatchDeleteDialog(true)
		}
	}

	return (
		<Tab>
			<TabHeader className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							className="px-1.5 -ml-2"
							onClick={onDone}
							aria-label={t("history:done")}
							data-testid="history-done-button">
							<ArrowLeft />
							<span className="sr-only">{t("history:done")}</span>
						</Button>
						<h3 className="text-vscode-foreground m-0">{t("history:history")}</h3>
					</div>
					<StandardTooltip
						content={
							isSelectionMode ? `${t("history:exitSelectionMode")}` : `${t("history:enterSelectionMode")}`
						}>
						<Button
							variant={isSelectionMode ? "primary" : "secondary"}
							onClick={toggleSelectionMode}
							data-testid="toggle-selection-mode-button">
							<span
								className={`codicon ${isSelectionMode ? "codicon-check-all" : "codicon-checklist"} mr-1`}
							/>
							{isSelectionMode ? t("history:exitSelection") : t("history:selectionMode")}
						</Button>
					</StandardTooltip>
				</div>
				<div className="flex flex-col gap-2">
					<VSCodeTextField
						className="w-full"
						placeholder={t("history:searchPlaceholder")}
						value={searchQuery}
						data-testid="history-search-input"
						onInput={(e) => {
							const newValue = (e.target as HTMLInputElement)?.value
							setSearchQuery(newValue)
							if (newValue && !searchQuery && sortOption !== "mostRelevant") {
								setLastNonRelevantSort(sortOption)
								setSortOption("mostRelevant")
							}
						}}>
						<div slot="start" className="codicon codicon-search mt-0.5 opacity-80 text-sm!" />
						{searchQuery && (
							<div
								className="input-icon-button codicon codicon-close flex justify-center items-center h-full"
								aria-label="Clear search"
								onClick={() => setSearchQuery("")}
								slot="end"
							/>
						)}
					</VSCodeTextField>
					<div className="flex gap-2">
						<Select
							value={showAllWorkspaces ? "all" : "current"}
							onValueChange={(value) => setShowAllWorkspaces(value === "all")}>
							<SelectTrigger className="flex-1">
								<SelectValue>
									{t("history:workspace.prefix")}{" "}
									{t(`history:workspace.${showAllWorkspaces ? "all" : "current"}`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="current">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-folder" />
										{t("history:workspace.current")}
									</div>
								</SelectItem>
								<SelectItem value="all">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-folder-opened" />
										{t("history:workspace.all")}
									</div>
								</SelectItem>
							</SelectContent>
						</Select>
						<Select value={sortOption} onValueChange={(value) => setSortOption(value as SortOption)}>
							<SelectTrigger className="flex-1">
								<SelectValue>
									{t("history:sort.prefix")} {t(`history:sort.${sortOption}`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="newest" data-testid="select-newest">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-arrow-down" />
										{t("history:newest")}
									</div>
								</SelectItem>
								<SelectItem value="oldest" data-testid="select-oldest">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-arrow-up" />
										{t("history:oldest")}
									</div>
								</SelectItem>
								<SelectItem value="mostExpensive" data-testid="select-most-expensive">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-credit-card" />
										{t("history:mostExpensive")}
									</div>
								</SelectItem>
								<SelectItem value="mostTokens" data-testid="select-most-tokens">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-symbol-numeric" />
										{t("history:mostTokens")}
									</div>
								</SelectItem>
								<SelectItem
									value="mostRelevant"
									disabled={!searchQuery}
									data-testid="select-most-relevant">
									<div className="flex items-center gap-2">
										<span className="codicon codicon-search" />
										{t("history:mostRelevant")}
									</div>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{isSelectionMode && tasks.length > 0 && (
						<div className="flex items-center py-1">
							<div className="flex items-center gap-2">
								<Checkbox
									checked={tasks.length > 0 && selectedTaskIds.length === tasks.length}
									onCheckedChange={(checked) => toggleSelectAll(checked === true)}
									variant="description"
								/>
								<span className="text-vscode-foreground text-xs">
									{selectedTaskIds.length === tasks.length
										? t("history:deselectAll")
										: t("history:selectAll")}
								</span>
								<span className="text-vscode-descriptionForeground text-xs">
									(
									{t("history:selectedItems", {
										selected: selectedTaskIds.length,
										total: tasks.length,
									})}
									)
								</span>
							</div>
						</div>
					)}
				</div>
			</TabHeader>

			<TabContent className="px-2 py-0">
				{isSearchMode && flatTasks ? (
					<Virtuoso
						className="flex-1 overflow-y-scroll"
						data={flatTasks}
						data-testid="virtuoso-container"
						initialTopMostItemIndex={0}
						components={{
							List: React.forwardRef((props, ref) => (
								<div {...props} ref={ref} data-testid="virtuoso-item-list" />
							)),
						}}
						itemContent={(_index, item) => (
							<TaskItem
								key={item.id}
								item={item}
								variant="full"
								showWorkspace={showAllWorkspaces}
								isSelectionMode={isSelectionMode}
								isSelected={selectedTaskIds.includes(item.id)}
								onToggleSelection={toggleTaskSelection}
								onDelete={handleDelete}
								className="m-2"
							/>
						)}
					/>
				) : (
					<Virtuoso
						className="flex-1 overflow-y-scroll"
						data={groups}
						data-testid="virtuoso-container"
						initialTopMostItemIndex={0}
						components={{
							List: React.forwardRef((props, ref) => (
								<div {...props} ref={ref} data-testid="virtuoso-item-list" />
							)),
						}}
						itemContent={(_index, group) => {
							const rootId = group.parent.id
							return (
								<TaskGroupItem
									key={rootId}
									group={group}
									variant="full"
									showWorkspace={showAllWorkspaces}
									isSelectionMode={isSelectionMode}
									isSelected={selectedTaskIds.includes(rootId)}
									onToggleSelection={toggleTaskSelection}
									onDelete={handleDelete}
									onToggleExpand={() => toggleExpand(rootId)}
									onToggleSubtaskExpand={toggleExpand}
									className="m-2"
								/>
							)
						}}
					/>
				)}
			</TabContent>

			{isSelectionMode && selectedTaskIds.length > 0 && (
				<div className="fixed bottom-0 left-0 right-2 bg-vscode-editor-background border-t border-vscode-panel-border p-2 flex justify-between items-center">
					<div className="text-vscode-foreground">
						{t("history:selectedItems", { selected: selectedTaskIds.length, total: tasks.length })}
					</div>
					<div className="flex gap-2">
						<Button variant="secondary" onClick={() => setSelectedTaskIds([])}>
							{t("history:clearSelection")}
						</Button>
						<Button variant="primary" onClick={handleBatchDelete}>
							{t("history:deleteSelected")}
						</Button>
					</div>
				</div>
			)}

			{deleteTaskId && (
				<DeleteTaskDialog
					taskId={deleteTaskId}
					subtaskCount={deleteSubtaskCount}
					onOpenChange={(open) => {
						if (!open) {
							setDeleteTaskId(null)
							setDeleteSubtaskCount(0)
						}
					}}
					open
				/>
			)}

			{showBatchDeleteDialog && (
				<BatchDeleteTaskDialog
					taskIds={selectedTaskIds}
					open={showBatchDeleteDialog}
					onOpenChange={(open) => {
						if (!open) {
							setShowBatchDeleteDialog(false)
							setSelectedTaskIds([])
							setIsSelectionMode(false)
						}
					}}
				/>
			)}
		</Tab>
	)
}

HistoryViewBaselineFallback.displayName = "HistoryViewBaselineFallback"

/**
 * History view with task organization (pin, folder, DnD) support.
 *
 * Wraps the inner view with an ErrorBoundary so that a failure in the
 * pin/folder feature never breaks the existing Virtuoso rendering.
 * On failure the boundary swaps in the baseline renderer so the original
 * grouped/search UI, selection actions, and task cards remain visible.
 */
const HistoryView = ({ onDone }: HistoryViewProps) => {
	return (
		<TaskOrganizationErrorBoundary fallback={<HistoryViewBaselineFallback onDone={onDone} />}>
			<TaskOrganizationInteractionProvider>
				<HistoryViewInner onDone={onDone} />
			</TaskOrganizationInteractionProvider>
		</TaskOrganizationErrorBoundary>
	)
}

export default memo(HistoryView)
