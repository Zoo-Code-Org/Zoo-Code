import React, { memo, useCallback, useMemo } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"

import type { SessionSummary, SessionDetail as SessionDetailType } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import SessionDetail from "./SessionDetail"

// ── Number formatting ───────────────────────────────────────────────────────

/**
 * Format a large number with K/M/B suffixes for display.
 * Mirrors the helper used in DashboardSummary/DashboardView.
 */
function formatCompact(value: number): string {
	if (value === 0) return "0"
	const abs = Math.abs(value)
	if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
	return value.toLocaleString()
}

function formatCost(value: number): string {
	if (value === 0) return "$0.00"
	if (value < 0.01) return `$${value.toFixed(4)}`
	return `$${value.toFixed(2)}`
}

// ── Relative time formatting ────────────────────────────────────────────────

/**
 * Formats a timestamp as a relative time string (e.g. "3 min ago",
 * "1 hr ago", "today"). Falls back to a localized absolute date for
 * timestamps older than 24 hours.
 *
 * The strings are intentionally short to fit the session row layout.
 * The i18n keys are not used here because the relative-time phrasing is
 * tightly coupled to the formatting logic; the absolute-date fallback
 * uses `toLocaleString()` which respects the user's locale.
 */
function formatRelativeTime(timestamp: number): string {
	const now = Date.now()
	const diffMs = now - timestamp
	const diffSec = Math.floor(diffMs / 1000)
	const diffMin = Math.floor(diffSec / 60)
	const diffHr = Math.floor(diffMin / 60)
	const diffDay = Math.floor(diffHr / 24)

	if (diffSec < 60) return "just now"
	if (diffMin < 60) return `${diffMin} min ago`
	if (diffHr < 24) return `${diffHr} hr ago`
	if (diffDay === 1) return "yesterday"
	if (diffDay < 7) return `${diffDay} days ago`

	// Older than a week: show absolute date.
	return new Date(timestamp).toLocaleDateString()
}

// ── Filter dropdown ─────────────────────────────────────────────────────────

/**
 * A single filter dropdown for model or provider selection.
 * Renders a Radix Select with an "All" option plus one item per unique value.
 */
interface FilterDropdownProps {
	/** i18n key for the placeholder / "All" option label. */
	allOptionLabel: string
	/** Currently selected value, or undefined for "All". */
	value: string | undefined
	/** Called when the user selects a value. `undefined` means "All". */
	onChange: (value: string | undefined) => void
	/** Unique values to populate the dropdown. */
	options: string[]
	/** Test id for the trigger element. */
	testId: string
}

const FilterDropdown = memo(
	({ allOptionLabel, value, onChange, options, testId }: FilterDropdownProps) => {
		// Radix Select uses empty string as the "All" sentinel value because
		// `undefined` is not a valid `value` for SelectItem.
		const currentValue = value ?? ""
		const ALL_VALUE = "__all__"

		const handleChange = useCallback(
			(next: string) => {
				onChange(next === ALL_VALUE ? undefined : next)
			},
			[onChange],
		)

		return (
			<Select value={currentValue || ALL_VALUE} onValueChange={handleChange}>
				<SelectTrigger
					className="h-7 text-xs"
					data-testid={testId}
					aria-label={allOptionLabel}>
					<SelectValue placeholder={allOptionLabel} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL_VALUE}>{allOptionLabel}</SelectItem>
					{options.map((opt) => (
						<SelectItem key={opt} value={opt}>
							{opt}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		)
	},
)

FilterDropdown.displayName = "FilterDropdown"

// ── Session row ──────────────────────────────────────────────────────────────

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
			<span className="text-xs text-vscode-descriptionForeground">
				{t("dashboard:states.loading")}
			</span>
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

interface SessionRowProps {
	session: SessionSummary
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

const SessionRow = memo(
	({ session, isExpanded, detail, detailError, detailLoading, onToggle }: SessionRowProps) => {
		const { t } = useAppTranslation()

		const handleClick = useCallback(() => {
			onToggle(session.taskId)
		}, [onToggle, session.taskId])

		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onToggle(session.taskId)
				}
			},
			[onToggle, session.taskId],
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
							<span
								className="truncate text-xs font-medium text-vscode-foreground"
								title={session.title}>
								{session.title}
							</span>
							<span className="text-[10px] text-vscode-descriptionForeground">
								{formatRelativeTime(session.timestamp)}
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
							{t("dashboard:sessions.callCount", { count: session.callCount })}
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
	},
)

SessionRow.displayName = "SessionRow"

// ── SessionList ─────────────────────────────────────────────────────────────

interface SessionListProps {
	sessions: SessionSummary[]
	/** Currently selected model filter, or undefined for "All Models". */
	modelFilter: string | undefined
	/** Currently selected provider filter, or undefined for "All Providers". */
	providerFilter: string | undefined
	/** Called when the model filter changes. */
	onModelFilterChange: (value: string | undefined) => void
	/** Called when the provider filter changes. */
	onProviderFilterChange: (value: string | undefined) => void
	/** The taskId of the currently expanded session, or undefined if none. */
	expandedTaskId?: string
	/** Map of taskId -> loaded session detail (only populated for expanded rows). */
	sessionDetails: Record<string, SessionDetailType | null>
	/** Map of taskId -> detail fetch error message (only populated for failed fetches). */
	sessionDetailErrors: Record<string, string | null>
	/** Set of taskIds whose detail is currently being fetched. */
	sessionDetailLoading: Set<string>
	/** Called when the user clicks a session row to toggle its expansion. */
	onToggleSession: (taskId: string) => void
}

const SessionList = memo(
	({
		sessions,
		modelFilter,
		providerFilter,
		onModelFilterChange,
		onProviderFilterChange,
		expandedTaskId,
		sessionDetails,
		sessionDetailErrors,
		sessionDetailLoading,
		onToggleSession,
	}: SessionListProps) => {
		const { t } = useAppTranslation()

		// Extract unique models and providers from the session list for the
		// filter dropdown options. Sorted alphabetically for stable display.
		const uniqueModels = useMemo(() => {
			const set = new Set<string>()
			for (const s of sessions) set.add(s.model)
			return Array.from(set).sort((a, b) => a.localeCompare(b))
		}, [sessions])

		const uniqueProviders = useMemo(() => {
			const set = new Set<string>()
			for (const s of sessions) set.add(s.provider)
			return Array.from(set).sort((a, b) => a.localeCompare(b))
		}, [sessions])

		return (
			<div className="flex flex-col gap-2" data-testid="dashboard-sessions">
				<div className="flex items-center justify-between">
					<h4 className="m-0 text-sm font-medium text-vscode-foreground">
						{t("dashboard:sessions.title")}
					</h4>
					<div className="flex flex-wrap items-center gap-1">
						<FilterDropdown
							allOptionLabel={t("dashboard:sessions.filterModel")}
							value={modelFilter}
							onChange={onModelFilterChange}
							options={uniqueModels}
							testId="dashboard-session-filter-model"
						/>
						<FilterDropdown
							allOptionLabel={t("dashboard:sessions.filterProvider")}
							value={providerFilter}
							onChange={onProviderFilterChange}
							options={uniqueProviders}
							testId="dashboard-session-filter-provider"
						/>
					</div>
				</div>

				{sessions.length === 0 ? (
					<div
						className="flex items-center justify-center py-4 text-xs text-vscode-descriptionForeground"
						data-testid="dashboard-sessions-empty">
						{t("dashboard:sessions.noSessions")}
					</div>
				) : (
					<div className="overflow-hidden rounded-md border border-vscode-panel-border">
						{sessions.map((session) => {
							const isExpanded = expandedTaskId === session.taskId
							return (
								<SessionRow
									key={session.taskId}
									session={session}
									isExpanded={isExpanded}
									detail={isExpanded ? sessionDetails[session.taskId] : undefined}
									detailError={isExpanded ? sessionDetailErrors[session.taskId] ?? undefined : undefined}
									detailLoading={isExpanded && sessionDetailLoading.has(session.taskId)}
									onToggle={onToggleSession}
								/>
							)
						})}
					</div>
				)}
			</div>
		)
	},
)

SessionList.displayName = "SessionList"

export default SessionList
