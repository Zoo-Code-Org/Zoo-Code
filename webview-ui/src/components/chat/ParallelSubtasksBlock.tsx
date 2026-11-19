import React, { useEffect, useState } from "react"
import type { ParallelSubtaskInfo } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { Button, StandardTooltip } from "@/components/ui"

interface ParallelSubtasksBlockProps {
	subtasks: ParallelSubtaskInfo[]
	partial: boolean
	/**
	 * Ids of every child this parent registered in task history. Rows whose id
	 * is absent have no task behind them: `dropped-N` rows and the random ids
	 * `failedBackgroundHandle` mints for rejected specs never reach the history
	 * store, so their navigation/debug buttons would open (and, for the debug
	 * view, create) a task directory that does not exist. Undefined means the
	 * caller does not know the parent's children yet and the buttons keep their
	 * previous behavior.
	 */
	childTaskIds?: readonly string[]
}

interface StatusVisual {
	icon: string
	color: string
	spin: boolean
}

// Status visuals follow the terminal-dot convention of sibling tool blocks:
// green for success, red for failure, yellow/blue for in-flight work, and the
// description foreground for inactive states.
const STATUS_VISUALS: Record<ParallelSubtaskInfo["status"], StatusVisual> = {
	queued: { icon: "codicon-circle-large-outline", color: "var(--vscode-descriptionForeground)", spin: false },
	running: { icon: "codicon-loading", color: "var(--vscode-charts-blue)", spin: true },
	completed: { icon: "codicon-check", color: "var(--vscode-charts-green)", spin: false },
	failed: { icon: "codicon-x", color: "var(--vscode-charts-red)", spin: false },
	aborted: { icon: "codicon-circle-slash", color: "var(--vscode-descriptionForeground)", spin: false },
}

const isTerminal = (status: ParallelSubtaskInfo["status"]) =>
	status === "completed" || status === "failed" || status === "aborted"

/** Human-readable duration for the elapsed-time badge, e.g. "45s" or "3m 12s". */
export const formatElapsed = (ms: number): string => {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	if (hours > 0) {
		return `${hours}h ${minutes}m`
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`
	}
	return `${seconds}s`
}

const headerStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
	cursor: "default",
	marginBottom: "6px",
	wordBreak: "break-word",
}

const rowStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "4px",
	padding: "6px 0",
	borderTop: "1px solid var(--vscode-editorGroup-border)",
}

const rowMainStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
	minWidth: 0,
}

const labelStyle: React.CSSProperties = {
	flex: 1,
	minWidth: 0,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	fontWeight: 500,
	color: "var(--vscode-foreground)",
}

const modeBadgeStyle: React.CSSProperties = {
	flexShrink: 0,
	padding: "0 6px",
	borderRadius: "4px",
	fontSize: "calc(var(--vscode-font-size) - 2px)",
	lineHeight: "16px",
	background: "var(--vscode-badge-background)",
	color: "var(--vscode-badge-foreground)",
}

const elapsedStyle: React.CSSProperties = {
	flexShrink: 0,
	fontFamily: "var(--vscode-editor-font-family, monospace)",
	fontSize: "calc(var(--vscode-font-size) - 1px)",
	color: "var(--vscode-descriptionForeground)",
}

const terminalLineStyle: React.CSSProperties = {
	margin: 0,
	paddingLeft: "22px",
	fontSize: "calc(var(--vscode-font-size) - 1px)",
	color: "var(--vscode-descriptionForeground)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
}

const actionsStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "2px",
	flexShrink: 0,
}

const requestMessageStyle: React.CSSProperties = {
	margin: 0,
	paddingLeft: "22px",
	fontSize: "calc(var(--vscode-font-size) - 1px)",
	color: "var(--vscode-descriptionForeground)",
	overflow: "hidden",
	wordBreak: "break-word",
}

const requestPreviewStyle: React.CSSProperties = {
	...requestMessageStyle,
	display: "-webkit-box",
	WebkitLineClamp: 2,
	WebkitBoxOrient: "vertical",
}

/** `dropped-N` rows are minted by the tool when the per-call cap slices a batch. */
const isDroppedRowId = (taskId: string): boolean => /^dropped-\d+$/.test(taskId)

/**
 * A row has a real task behind it unless the host synthesized the id. Dropped
 * rows never exist, and a rejected spec's handle id is never registered in the
 * parent's `childIds`, so only positively known child ids qualify when the
 * caller supplies the list.
 */
const hasRealTask = (taskId: string, childTaskIds?: readonly string[]): boolean => {
	if (isDroppedRowId(taskId)) {
		return false
	}
	return childTaskIds === undefined || childTaskIds.includes(taskId)
}

/** One requested child in the ask payload (`parallel_subtasks.tasks[]`). */
export interface ParallelSubtaskRequest {
	label: string
	mode: string
	message: string
}

/**
 * One requested task at the single approval point. The message keeps the
 * compact two-line preview, with an explicit disclosure control (and the full
 * text as the paragraph's title) so the complete instructions are reachable
 * before approval.
 */
const ParallelSubtaskRequestRow: React.FC<{ task: ParallelSubtaskRequest; index: number }> = ({ task, index }) => {
	const { t } = useAppTranslation()
	const [expanded, setExpanded] = useState(false)
	const toggleLabel = expanded ? t("chat:task.collapse") : t("chat:task.expand")

	return (
		<div data-testid={`parallel-subtask-request-${index}`} style={rowStyle}>
			<div style={rowMainStyle}>
				<span
					className="codicon codicon-circle-large-outline"
					style={{ color: "var(--vscode-descriptionForeground)", flexShrink: 0 }}
					aria-label={t("chat:parallelSubtasks.status.queued")}
				/>
				<span style={labelStyle} title={task.label}>
					{task.label}
				</span>
				<span data-testid={`parallel-subtask-request-mode-${index}`} style={modeBadgeStyle}>
					{task.mode}
				</span>
				{task.message ? (
					<StandardTooltip content={toggleLabel}>
						<Button
							variant="ghost"
							size="icon"
							aria-expanded={expanded}
							aria-label={toggleLabel}
							onClick={() => setExpanded((value) => !value)}>
							<span className={`codicon ${expanded ? "codicon-chevron-up" : "codicon-chevron-down"}`} />
						</Button>
					</StandardTooltip>
				) : null}
			</div>
			{task.message ? (
				<p
					data-testid={`parallel-subtask-request-message-${index}`}
					style={expanded ? requestMessageStyle : requestPreviewStyle}
					title={task.message}>
					{task.message}
				</p>
			) : null}
		</div>
	)
}

/**
 * Approval-time rendering of one `parallel_subtasks` call (design §11).
 *
 * The ask text carries the requested tasks (`{ label, mode, message }`) because
 * no child exists before the single approval point; the say-side panel renders
 * live `subtasks` rows instead. Header and row chrome mirror that panel so the
 * approval and the progress report read as one surface.
 */
export const ParallelSubtasksPreview: React.FC<{ tasks: ParallelSubtaskRequest[] }> = ({ tasks }) => {
	const { t } = useAppTranslation()

	return (
		<div>
			<div style={headerStyle}>
				<span
					className="codicon codicon-run-all"
					style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}
				/>
				<span style={{ fontWeight: "bold" }}>{t("chat:parallelSubtasks.title")}</span>
			</div>
			<div>
				{tasks.map((task, index) => (
					<ParallelSubtaskRequestRow key={`${task.label}-${index}`} task={task} index={index} />
				))}
			</div>
		</div>
	)
}

/**
 * N-row progress/completion panel for one parallel_subtasks call (design D9).
 * Rendered from the say channel, so it must never carry approval state; the
 * buttons only read host-side state (report files, debug logs, task history).
 */
const ParallelSubtasksBlock: React.FC<ParallelSubtasksBlockProps> = ({ subtasks, partial, childTaskIds }) => {
	const { t } = useAppTranslation()
	const [now, setNow] = useState(() => Date.now())

	const anyRunning = subtasks.some((subtask) => subtask.status === "running")
	useEffect(() => {
		if (!anyRunning) {
			return
		}
		const interval = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(interval)
	}, [anyRunning])

	const completedCount = subtasks.filter((subtask) => subtask.status === "completed").length

	return (
		<div>
			<div style={headerStyle}>
				<span
					className={partial ? "codicon codicon-loading codicon-modifier-spin" : "codicon codicon-run-all"}
					style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}
				/>
				<span style={{ fontWeight: "bold" }}>{t("chat:parallelSubtasks.title")}</span>
				<span style={{ color: "var(--vscode-descriptionForeground)" }}>
					{t("chat:parallelSubtasks.progress", { completed: completedCount, total: subtasks.length })}
				</span>
			</div>
			<div>
				{subtasks.map((subtask) => {
					const visual = STATUS_VISUALS[subtask.status]
					const hasTask = hasRealTask(subtask.taskId, childTaskIds)
					const elapsed =
						subtask.status === "running" && subtask.startedAt !== undefined
							? formatElapsed(now - subtask.startedAt)
							: undefined
					const terminalLine = !isTerminal(subtask.status)
						? undefined
						: subtask.status === "completed"
							? subtask.summary
							: subtask.error
					return (
						<div
							key={subtask.taskId}
							data-testid={`parallel-subtask-row-${subtask.taskId}`}
							style={rowStyle}>
							<div style={rowMainStyle}>
								<span
									className={`codicon ${visual.icon}${visual.spin ? " codicon-modifier-spin" : ""}`}
									style={{ color: visual.color, flexShrink: 0 }}
									aria-label={t(`chat:parallelSubtasks.status.${subtask.status}`)}
								/>
								<span style={labelStyle} title={subtask.label}>
									{subtask.label}
								</span>
								<span data-testid={`parallel-subtask-mode-${subtask.taskId}`} style={modeBadgeStyle}>
									{subtask.mode}
								</span>
								{elapsed !== undefined && (
									<span
										data-testid={`parallel-subtask-elapsed-${subtask.taskId}`}
										style={elapsedStyle}>
										{elapsed}
									</span>
								)}
								<div style={actionsStyle}>
									<StandardTooltip
										content={
											subtask.reportPath
												? t("chat:parallelSubtasks.openReport")
												: t("chat:parallelSubtasks.noReport")
										}>
										<Button
											variant="ghost"
											size="sm"
											disabled={!subtask.reportPath}
											onClick={() => {
												if (subtask.reportPath) {
													vscode.postMessage({ type: "openFile", text: subtask.reportPath })
												}
											}}>
											{t("chat:parallelSubtasks.openReport")}
										</Button>
									</StandardTooltip>
									{hasTask && (
										<>
											<StandardTooltip content={t("chat:parallelSubtasks.openDebugLog")}>
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
														vscode.postMessage({
															type: "openDebugUiHistory",
															taskId: subtask.taskId,
														})
													}>
													{t("chat:parallelSubtasks.openDebugLog")}
												</Button>
											</StandardTooltip>
											<StandardTooltip content={t("chat:parallelSubtasks.goToTask")}>
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
														vscode.postMessage({
															type: "showTaskWithId",
															text: subtask.taskId,
														})
													}>
													{t("chat:parallelSubtasks.goToTask")}
												</Button>
											</StandardTooltip>
										</>
									)}
								</div>
							</div>
							{terminalLine && (
								<p data-testid={`parallel-subtask-line-${subtask.taskId}`} style={terminalLineStyle}>
									{terminalLine}
								</p>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}

export default ParallelSubtasksBlock
