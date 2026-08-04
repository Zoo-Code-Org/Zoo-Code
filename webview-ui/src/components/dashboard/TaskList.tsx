import React, { memo, useCallback, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import i18next from "i18next"

import type { DashboardTaskDetail, DashboardTaskSummary } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { formatCompact, formatCost } from "@/utils/formatNumber"

import SessionDetail from "./SessionDetail"

// ── Relative time formatting ────────────────────────────────────────────────

/**
 * Formats a timestamp as a relative time string (e.g. "3 min ago",
 * "1 hr ago", "yesterday"). Falls back to a localized absolute date for
 * timestamps older than a week.
 *
 * Uses i18n keys from the `dashboard:time.*` namespace so the phrasing
 * is translated for each locale. The absolute-date fallback uses
 * `toLocaleDateString()` which respects the user's locale.
 */
function formatRelativeTime(timestamp: number): string {
	const now = Date.now()
	const diffMs = now - timestamp
	const diffSec = Math.floor(diffMs / 1000)
	const diffMin = Math.floor(diffSec / 60)
	const diffHr = Math.floor(diffMin / 60)
	const diffDay = Math.floor(diffHr / 24)

	if (diffSec < 60) return i18next.t("dashboard:time.justNow")
	if (diffMin < 60) return i18next.t("dashboard:time.minutesAgo", { count: diffMin })
	if (diffHr < 24) return i18next.t("dashboard:time.hoursAgo", { count: diffHr })
	if (diffDay === 1) return i18next.t("dashboard:time.yesterday")
	if (diffDay < 7) return i18next.t("dashboard:time.daysAgo", { count: diffDay })

	// Older than a week: show absolute date.
	return new Date(timestamp).toLocaleDateString()
}

// ── Task detail loading / error states ──────────────────────────────────────

/**
 * The loading state for a task row whose detail is being fetched.
 * Rendered in place of {@link SessionDetail} while the IPC request is in
 * flight so the user gets immediate feedback that their click was registered.
 */
const TaskDetailLoading = memo(() => {
	const { t } = useAppTranslation()
	return (
		<div
			className="flex items-center justify-center gap-2 border-t border-vscode-panel-border bg-vscode-editor-background px-2 py-3"
			data-testid="dashboard-task-detail-loading">
			<RefreshCw className="size-3.5 animate-spin text-vscode-descriptionForeground" />
			<span className="text-xs text-vscode-descriptionForeground">{t("dashboard:states.loading")}</span>
		</div>
	)
})

TaskDetailLoading.displayName = "TaskDetailLoading"

/**
 * The error state for a task row whose detail fetch failed. Rendered in
 * place of {@link SessionDetail} so the user can see the error inline and
 * try expanding another row.
 */
const TaskDetailError = memo(({ error }: { error: string }) => {
	return (
		<div
			className="flex items-center justify-center border-t border-vscode-panel-border bg-vscode-editor-background px-2 py-3 text-xs text-vscode-errorForeground"
			data-testid="dashboard-task-detail-error">
			{error}
		</div>
	)
})

TaskDetailError.displayName = "TaskDetailError"

// ── Task row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
	task: DashboardTaskSummary
	/** Chevron direction state (children list or detail slot open). */
	isExpanded: boolean
	/** Indent the row as a subtask of the expanded root above it. */
	indent?: boolean
	/** The loaded detail for this task, or undefined if not loaded/failed. */
	detail?: DashboardTaskDetail | null
	/** The error message if the detail fetch failed, or undefined. */
	detailError?: string | null
	/** Whether the detail fetch is currently in flight. */
	detailLoading: boolean
	/** Whether the detail slot renders below this row. */
	showDetail: boolean
	/** Called when the user clicks the row to toggle expansion. */
	onToggle: (taskId: string) => void
}

const TaskRow = memo(
	({ task, isExpanded, indent = false, detail, detailError, detailLoading, showDetail, onToggle }: TaskRowProps) => {
		const { t } = useAppTranslation()
		const metadata = [formatRelativeTime(task.lastUsageAt ?? task.taskTimestamp), task.model, task.provider]
			.filter(Boolean)
			.join(" · ")

		const handleClick = useCallback(() => {
			onToggle(task.taskId)
		}, [onToggle, task.taskId])

		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onToggle(task.taskId)
				}
			},
			[onToggle, task.taskId],
		)

		return (
			<div data-testid={indent ? "dashboard-subtask-row-container" : "dashboard-task-row-container"}>
				<div
					className={`flex items-center justify-between gap-2 border-b border-vscode-panel-border px-2 py-1.5 last:border-b-0 hover:bg-vscode-list-hoverBackground cursor-pointer${indent ? " pl-6" : ""}`}
					data-testid={indent ? "dashboard-subtask-row" : "dashboard-task-row"}
					role="button"
					tabIndex={0}
					aria-expanded={isExpanded}
					onClick={handleClick}
					onKeyDown={handleKeyDown}>
					<div className="flex min-w-0 flex-1 items-center gap-1">
						{isExpanded ? (
							<ChevronDown className="size-3.5 shrink-0 text-vscode-descriptionForeground" />
						) : (
							<ChevronRight className="size-3.5 shrink-0 text-vscode-descriptionForeground" />
						)}
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-xs font-medium text-vscode-foreground" title={task.title}>
								{task.title}
							</span>
							<span className="text-[10px] text-vscode-descriptionForeground">{metadata}</span>
						</div>
					</div>
					<div className="flex flex-col items-end gap-0.5 whitespace-nowrap">
						<span className="text-xs font-medium text-vscode-foreground tabular-nums">
							{formatCompact(task.totalTokens)}
						</span>
						<span className="text-[10px] text-vscode-descriptionForeground tabular-nums">
							{formatCost(task.totalCost)}
							{" · "}
							{t("dashboard:tasks.callCount", { count: task.eventCount })}
						</span>
					</div>
				</div>
				{showDetail && (
					<>
						{detailLoading ? (
							<TaskDetailLoading />
						) : detailError ? (
							<TaskDetailError error={detailError} />
						) : detail ? (
							<SessionDetail detail={detail} />
						) : null}
					</>
				)}
			</div>
		)
	},
)

TaskRow.displayName = "TaskRow"

// ── Root task item (row + expansion) ─────────────────────────────────────────

interface RootTaskItemProps {
	/** The root task summary. */
	task: DashboardTaskSummary
	/** Normalized summaries of roots AND subtasks (for resolving childTaskIds). */
	tasksById: Record<string, DashboardTaskSummary>
	/** Whether this root's subtask list is expanded. */
	isRootExpanded: boolean
	/** The task whose detail slot is open (a childless root or a subtask). */
	expandedDetailTaskId?: string
	/** Map of task ID -> loaded task detail (only populated for expanded rows). */
	taskDetails: Record<string, DashboardTaskDetail | null>
	/** Map of task ID -> detail fetch error message (only populated for failed fetches). */
	taskDetailErrors: Record<string, string | null>
	/** Set of task IDs whose detail is currently being fetched. */
	taskDetailLoading: Set<string>
	/** Called when the user clicks any row to toggle its expansion. */
	onToggleTask: (taskId: string) => void
}

/**
 * One root row plus its expansion area. Roots with subtasks expand into an
 * indented subtask list (each subtask toggles its own detail); childless roots
 * expand directly into the API-call detail as before.
 */
const RootTaskItem = memo(
	({
		task,
		tasksById,
		isRootExpanded,
		expandedDetailTaskId,
		taskDetails,
		taskDetailErrors,
		taskDetailLoading,
		onToggleTask,
	}: RootTaskItemProps) => {
		// Tolerate legacy summaries that predate childTaskIds (older hosts).
		const childTasks = (task.childTaskIds ?? []).map((id) => tasksById[id]).filter(Boolean)
		const hasChildren = childTasks.length > 0

		if (hasChildren) {
			return (
				<div data-testid="dashboard-task-row-container">
					<TaskRow
						task={task}
						isExpanded={isRootExpanded}
						detailLoading={false}
						showDetail={false}
						onToggle={onToggleTask}
					/>
					{isRootExpanded && (
						<div data-testid="dashboard-subtask-list">
							{childTasks.map((child) => {
								const isDetailOpen = expandedDetailTaskId === child.taskId
								return (
									<TaskRow
										key={child.taskId}
										task={child}
										indent
										isExpanded={isDetailOpen}
										detail={isDetailOpen ? taskDetails[child.taskId] : undefined}
										detailError={
											isDetailOpen ? (taskDetailErrors[child.taskId] ?? undefined) : undefined
										}
										detailLoading={isDetailOpen && taskDetailLoading.has(child.taskId)}
										showDetail={isDetailOpen}
										onToggle={onToggleTask}
									/>
								)
							})}
						</div>
					)}
				</div>
			)
		}

		const isDetailOpen = expandedDetailTaskId === task.taskId
		return (
			<TaskRow
				task={task}
				isExpanded={isDetailOpen}
				detail={isDetailOpen ? taskDetails[task.taskId] : undefined}
				detailError={isDetailOpen ? (taskDetailErrors[task.taskId] ?? undefined) : undefined}
				detailLoading={isDetailOpen && taskDetailLoading.has(task.taskId)}
				showDetail={isDetailOpen}
				onToggle={onToggleTask}
			/>
		)
	},
)

RootTaskItem.displayName = "RootTaskItem"

// ── TaskList ────────────────────────────────────────────────────────────────

interface TaskListProps {
	/** Ordered list of ROOT task summaries from the stream. */
	tasks: DashboardTaskSummary[]
	/** Normalized summaries of roots AND subtasks (keyed by task ID). */
	tasksById: Record<string, DashboardTaskSummary>
	/** The root task ID whose subtask list is expanded, or undefined if none. */
	expandedRootId?: string
	/** The task ID whose detail slot is open (a childless root or a subtask). */
	expandedDetailTaskId?: string
	/** Map of task ID -> loaded task detail (only populated for expanded rows). */
	taskDetails: Record<string, DashboardTaskDetail | null>
	/** Map of task ID -> detail fetch error message (only populated for failed fetches). */
	taskDetailErrors: Record<string, string | null>
	/** Set of task IDs whose detail is currently being fetched. */
	taskDetailLoading: Set<string>
	/** Called when the user clicks a task row to toggle its expansion. */
	onToggleTask: (taskId: string) => void
	/** Called when the user scrolls near the bottom (for cursor paging). Optional. */
	onLoadMore?: () => void
	/** Opaque cursor for the next task page, undefined when the final page is loaded. */
	taskCursor?: string
	/** Whether a task page request is currently in flight. */
	taskPageLoading?: boolean
	/** Estimated total task count for display. Optional. */
	totalEstimate?: number
}

const TaskList = memo(
	({
		tasks,
		tasksById,
		expandedRootId,
		expandedDetailTaskId,
		taskDetails,
		taskDetailErrors,
		taskDetailLoading,
		onToggleTask,
		onLoadMore,
		taskCursor,
		taskPageLoading = false,
		totalEstimate,
	}: TaskListProps) => {
		const { t } = useAppTranslation()
		const virtuosoRef = useRef<VirtuosoHandle>(null)

		// Virtuoso requires a definite viewport height: with only `maxHeight` set,
		// the scroller's `height: 100%` resolves against an auto-height parent,
		// collapses to 0, and deadlocks (0 viewport → 0 rendered items → 0 content
		// height). Driving an explicit (capped) height from the measured total list
		// height keeps the "grow up to 400px" behavior without the deadlock;
		// `initialItemCount` bootstraps the first measurement pass.
		const [listHeight, setListHeight] = useState(0)

		return (
			<div className="flex flex-col gap-2" data-testid="dashboard-tasks">
				<div className="flex items-center justify-between">
					<h4 className="m-0 text-sm font-medium text-vscode-foreground">
						{t("dashboard:tasks.title")}
						{totalEstimate !== undefined && totalEstimate > 0 && (
							<span className="ml-1 text-xs text-vscode-descriptionForeground">({totalEstimate})</span>
						)}
					</h4>
				</div>

				{tasks.length === 0 ? (
					<div
						className="flex items-center justify-center py-4 text-xs text-vscode-descriptionForeground"
						data-testid="dashboard-tasks-empty">
						{t("dashboard:tasks.noTasks")}
					</div>
				) : (
					<div className="overflow-hidden rounded-md border border-vscode-panel-border">
						<Virtuoso
							ref={virtuosoRef}
							data={tasks}
							initialItemCount={Math.min(5, tasks.length)}
							style={{ height: Math.min(listHeight, 400) || undefined }}
							totalListHeightChanged={setListHeight}
							itemContent={(_index, task) => (
								<RootTaskItem
									key={task.taskId}
									task={task}
									tasksById={tasksById}
									isRootExpanded={expandedRootId === task.taskId}
									expandedDetailTaskId={expandedDetailTaskId}
									taskDetails={taskDetails}
									taskDetailErrors={taskDetailErrors}
									taskDetailLoading={taskDetailLoading}
									onToggleTask={onToggleTask}
								/>
							)}
							endReached={() => {
								if (taskCursor && !taskPageLoading) {
									onLoadMore?.()
								}
							}}
						/>
					</div>
				)}
			</div>
		)
	},
)

TaskList.displayName = "TaskList"

export default TaskList
