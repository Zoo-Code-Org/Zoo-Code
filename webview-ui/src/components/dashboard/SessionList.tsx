import React, { memo, useCallback, useRef } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import i18next from "i18next"

import type { DashboardSessionSummary, SessionDetail as SessionDetailType } from "@roo-code/types"

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

// ── Session detail loading / error states ───────────────────────────────────

/**
 * The loading state for a session row whose detail is being fetched.
 * Rendered in place of {@link SessionDetail} while the IPC request is in
 * flight so the user gets immediate feedback that their click was registered.
 */
const SessionDetailLoading = memo(() => {
	const { t } = useAppTranslation()
	return (
		<div
			className="flex items-center justify-center gap-2 border-t border-vscode-panel-border bg-vscode-editor-background px-2 py-3"
			data-testid="dashboard-session-detail-loading">
			<RefreshCw className="size-3.5 animate-spin text-vscode-descriptionForeground" />
			<span className="text-xs text-vscode-descriptionForeground">{t("dashboard:states.loading")}</span>
		</div>
	)
})

SessionDetailLoading.displayName = "SessionDetailLoading"

/**
 * The error state for a session row whose detail fetch failed. Rendered in
 * place of {@link SessionDetail} so the user can see the error inline and
 * try expanding another row.
 */
const SessionDetailError = memo(({ error }: { error: string }) => {
	return (
		<div
			className="flex items-center justify-center border-t border-vscode-panel-border bg-vscode-editor-background px-2 py-3 text-xs text-vscode-errorForeground"
			data-testid="dashboard-session-detail-error">
			{error}
		</div>
	)
})

SessionDetailError.displayName = "SessionDetailError"

// ── Session row ──────────────────────────────────────────────────────────────

interface SessionRowProps {
	session: DashboardSessionSummary
	/** Whether this row is currently expanded. */
	isExpanded: boolean
	/** The loaded detail for this session, or undefined if not loaded/failed. */
	detail?: SessionDetailType | null
	/** The error message if the detail fetch failed, or undefined. */
	detailError?: string | null
	/** Whether the detail fetch is currently in flight. */
	detailLoading: boolean
	/** Called when the user clicks the row to toggle expansion. */
	onToggle: (taskId: string) => void
}

const SessionRow = memo(({ session, isExpanded, detail, detailError, detailLoading, onToggle }: SessionRowProps) => {
	const { t } = useAppTranslation()

	const handleClick = useCallback(() => {
		onToggle(session.rootTaskId)
	}, [onToggle, session.rootTaskId])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault()
				onToggle(session.rootTaskId)
			}
		},
		[onToggle, session.rootTaskId],
	)

	return (
		<div data-testid="dashboard-session-row-container">
			<div
				className="flex items-center justify-between gap-2 border-b border-vscode-panel-border px-2 py-1.5 last:border-b-0 hover:bg-vscode-list-hoverBackground cursor-pointer"
				data-testid="dashboard-session-row"
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
						<span className="truncate text-xs font-medium text-vscode-foreground" title={session.title}>
							{session.title}
						</span>
						<span className="text-[10px] text-vscode-descriptionForeground">
							{formatRelativeTime(session.lastActivity)}
							{" \u00b7 "}
							{session.model}
							{" \u00b7 "}
							{session.provider}
						</span>
					</div>
				</div>
				<div className="flex flex-col items-end gap-0.5 whitespace-nowrap">
					<span className="text-xs font-medium text-vscode-foreground tabular-nums">
						{formatCompact(session.totalTokens)}
					</span>
					<span className="text-[10px] text-vscode-descriptionForeground tabular-nums">
						{formatCost(session.totalCost)}
						{" \u00b7 "}
						{t("dashboard:sessions.callCount", { count: session.eventCount })}
					</span>
				</div>
			</div>
			{isExpanded && (
				<>
					{detailLoading ? (
						<SessionDetailLoading />
					) : detailError ? (
						<SessionDetailError error={detailError} />
					) : detail ? (
						<SessionDetail detail={detail} />
					) : null}
				</>
			)}
		</div>
	)
})

SessionRow.displayName = "SessionRow"

// ── SessionList ─────────────────────────────────────────────────────────────

interface SessionListProps {
	/** Ordered list of session summaries from the stream. */
	sessions: DashboardSessionSummary[]
	/** The rootTaskId of the currently expanded session, or undefined if none. */
	expandedTaskId?: string
	/** Map of rootTaskId -> loaded session detail (only populated for expanded rows). */
	sessionDetails: Record<string, SessionDetailType | null>
	/** Map of rootTaskId -> detail fetch error message (only populated for failed fetches). */
	sessionDetailErrors: Record<string, string | null>
	/** Set of rootTaskIds whose detail is currently being fetched. */
	sessionDetailLoading: Set<string>
	/** Called when the user clicks a session row to toggle its expansion. */
	onToggleSession: (taskId: string) => void
	/** Called when the user scrolls near the bottom (for cursor paging). Optional. */
	onLoadMore?: () => void
	/** Estimated total session count for display. Optional. */
	totalEstimate?: number
}

const SessionList = memo(
	({
		sessions,
		expandedTaskId,
		sessionDetails,
		sessionDetailErrors,
		sessionDetailLoading,
		onToggleSession,
		onLoadMore,
		totalEstimate,
	}: SessionListProps) => {
		const { t } = useAppTranslation()
		const virtuosoRef = useRef<VirtuosoHandle>(null)

		return (
			<div className="flex flex-col gap-2" data-testid="dashboard-sessions">
				<div className="flex items-center justify-between">
					<h4 className="m-0 text-sm font-medium text-vscode-foreground">
						{t("dashboard:sessions.title")}
						{totalEstimate !== undefined && totalEstimate > 0 && (
							<span className="ml-1 text-xs text-vscode-descriptionForeground">({totalEstimate})</span>
						)}
					</h4>
				</div>

				{sessions.length === 0 ? (
					<div
						className="flex items-center justify-center py-4 text-xs text-vscode-descriptionForeground"
						data-testid="dashboard-sessions-empty">
						{t("dashboard:sessions.noSessions")}
					</div>
				) : (
					<div className="overflow-hidden rounded-md border border-vscode-panel-border">
						<Virtuoso
							ref={virtuosoRef}
							data={sessions}
							style={{ maxHeight: 400 }}
							itemContent={(_index, session) => {
								const isExpanded = expandedTaskId === session.rootTaskId
								return (
									<SessionRow
										key={session.rootTaskId}
										session={session}
										isExpanded={isExpanded}
										detail={isExpanded ? sessionDetails[session.rootTaskId] : undefined}
										detailError={
											isExpanded
												? (sessionDetailErrors[session.rootTaskId] ?? undefined)
												: undefined
										}
										detailLoading={isExpanded && sessionDetailLoading.has(session.rootTaskId)}
										onToggle={onToggleSession}
									/>
								)
							}}
							endReached={() => {
								onLoadMore?.()
							}}
						/>
					</div>
				)}
			</div>
		)
	},
)

SessionList.displayName = "SessionList"

export default SessionList
