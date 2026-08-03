import React, { memo, useCallback, useRef } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import i18next from "i18next"

import type { DashboardTaskDetail, DashboardTaskSummary } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
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
	/** Whether this row is currently expanded. */
	isExpanded: boolean
	/** The loaded detail for this task, or undefined if not loaded/failed. */
	detail?: DashboardTaskDetail | null
	/** The error message if the detail fetch failed, or undefined. */
	detailError?: string | null
	/** Whether the detail fetch is currently in flight. */
	detailLoading: boolean
	/** Called when the user clicks the row to toggle expansion. */
	onToggle: (taskId: string) => void
}

const TaskRow = memo(({ task, isExpanded, detail, detailError, detailLoading, onToggle }: TaskRowProps) => {
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
		<div data-testid="dashboard-task-row-container">
			<div
				className="flex items-center justify-between gap-2 border-b border-vscode-panel-border px-2 py-1.5 last:border-b-0 hover:bg-vscode-list-hoverBackground cursor-pointer"
				data-testid="dashboard-task-row"
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
						{" \u00b7 "}
						{t("dashboard:tasks.callCount", { count: task.eventCount })}
					</span>
				</div>
			</div>
			{isExpanded && (
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
})

TaskRow.displayName = "TaskRow"

// ── TaskList ────────────────────────────────────────────────────────────────

interface TaskListProps {
	/** Ordered list of task summaries from the stream. */
	tasks: DashboardTaskSummary[]
	/** The task ID of the currently expanded task, or undefined if none. */
	expandedTaskId?: string
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
		expandedTaskId,
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
							style={{ maxHeight: 400 }}
							itemContent={(_index, task) => {
								const isExpanded = expandedTaskId === task.taskId
								return (
									<TaskRow
										key={task.taskId}
										task={task}
										isExpanded={isExpanded}
										detail={isExpanded ? taskDetails[task.taskId] : undefined}
										detailError={
											isExpanded
												? (taskDetailErrors[task.taskId] ?? undefined)
												: undefined
										}
										detailLoading={isExpanded && taskDetailLoading.has(task.taskId)}
										onToggle={onToggleTask}
									/>
								)
							}}
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
