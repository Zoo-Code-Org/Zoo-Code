import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"
import { Check, FileDiff, RotateCcw, X } from "lucide-react"
import { safeJsonParse } from "@roo/core"

import { changeCardSchema, type ClineMessage, type ExtensionMessage } from "@roo-code/types"

import { Button, StandardTooltip } from "@/components/ui"
import { vscode } from "@src/utils/vscode"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import CodeAccordion from "../common/CodeAccordion"

type RollbackStatus = "idle" | "confirming" | "pending" | "success" | "error"

type RollbackState = {
	status: RollbackStatus
	error?: string
}

const IDLE: RollbackState = { status: "idle" }

const successState: RollbackState = { status: "success" }

/**
 * Per-step change card (B3a payload, B3b UI): header with the file count, a
 * per-file list with +/− diff badges, and per-file / per-step rollback
 * controls wired to the extension host through the
 * `checkpointRollbackFile` / `checkpointRollbackStep` messages. Diffs come from
 * the payload's per-file `diff` field: `full` cards expand by default,
 * `summary` cards expand lazily on toggle, compact cards carry no diff.
 */
export const ChangeCard = ({ message }: { message: ClineMessage }) => {
	const { t } = useTranslation()

	const card = useMemo(() => {
		// Validate the shape, not just the JSON-ness: this text is persisted
		// task history, so a truncated or pre-series record must not throw
		// during render. Records that fail to parse (safeJsonParse returns
		// `undefined` without a default) or fail shape validation fall through
		// to the null path (an inert card row).
		const parsed = safeJsonParse<unknown>(message.text)
		if (parsed === undefined) {
			return null
		}
		const validated = changeCardSchema.safeParse(parsed)
		return validated.success ? validated.data : null
	}, [message.text])

	// Files whose diff is currently expanded. "full" cards expand inline by
	// default; "summary" cards keep the diff collapsed until toggled.
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => {
		if (!card || card.detail !== "full") {
			return new Set()
		}
		return new Set(card.files.filter((file) => file.diff != null).map((file) => file.path))
	})

	const [fileRollbacks, setFileRollbacks] = useState<Record<string, RollbackState>>({})
	const [stepRollback, setStepRollback] = useState<RollbackState>(IDLE)

	const checkpointId = card?.checkpointIds[0]

	// Correlate extension rollback results with this card by message ts.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const data = event.data as ExtensionMessage | undefined
			const result = data?.checkpointRollbackResult
			if (data?.type !== "checkpointRollbackResult" || !result) {
				return
			}
			if (result.cardTs !== message.ts) {
				return
			}
			const filePath = result.filePath
			if (filePath !== undefined) {
				setFileRollbacks((prev) => ({
					...prev,
					[filePath]: result.success ? successState : { status: "error", error: result.error },
				}))
			}
			if (result.files) {
				const fileUpdates: Record<string, RollbackState> = {}
				for (const file of result.files) {
					fileUpdates[file.filePath] = file.success ? successState : { status: "error", error: file.error }
				}
				setFileRollbacks((prev) => ({ ...prev, ...fileUpdates }))
				const firstFailure = result.files.find((file) => !file.success)
				setStepRollback(
					result.success ? successState : { status: "error", error: firstFailure?.error ?? result.error },
				)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [message.ts])

	if (!card || !checkpointId) {
		return null
	}

	const toggleFile = (path: string) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev)
			if (next.has(path)) {
				next.delete(path)
			} else {
				next.add(path)
			}
			return next
		})
	}

	const requestFileRollback = (path: string) => {
		vscode.postMessage({
			type: "checkpointRollbackFile",
			payload: { cardTs: message.ts, checkpointId, filePath: path },
		})
		setFileRollbacks((prev) => ({ ...prev, [path]: { status: "pending" } }))
	}

	const requestStepRollback = () => {
		vscode.postMessage({
			type: "checkpointRollbackStep",
			payload: { cardTs: message.ts, checkpointId, filePaths: card.files.map((file) => file.path) },
		})
		setStepRollback({ status: "pending" })
	}

	const diffBadges = (additions: number, deletions: number) =>
		additions > 0 || deletions > 0 ? (
			<span className="flex items-center gap-2 shrink-0" aria-hidden>
				<span className="text-xs font-medium text-vscode-charts-green">+{additions}</span>
				<span className="text-xs font-medium text-vscode-charts-red">-{deletions}</span>
			</span>
		) : null

	const fileRollbackControls = (path: string, index: number) => {
		const state = fileRollbacks[path] ?? IDLE
		const confirmTestId = `change-card-file-confirm-${index}`
		const cancelTestId = `change-card-file-cancel-${index}`

		switch (state.status) {
			case "confirming":
				return (
					<span className="flex items-center gap-1" data-testid={confirmTestId}>
						<Button variant="primary" size="sm" onClick={() => requestFileRollback(path)}>
							<Check className="size-3" aria-hidden />
							{t("chat:changeCard.confirm")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setFileRollbacks((prev) => ({ ...prev, [path]: IDLE }))}
							data-testid={cancelTestId}>
							{t("chat:changeCard.cancel")}
						</Button>
					</span>
				)
			case "pending":
				return (
					<span data-testid={`change-card-file-pending-${index}`}>
						<VSCodeProgressRing className="size-4" />
					</span>
				)
			case "success":
				return (
					<span
						className="flex items-center gap-1 text-xs font-medium text-vscode-charts-green"
						data-testid={`change-card-file-success-${index}`}>
						<Check className="size-3" aria-hidden />
						{t("chat:changeCard.rolledBack")}
					</span>
				)
			case "error":
				return (
					<StandardTooltip content={state.error ?? t("chat:changeCard.rollbackFailed")}>
						<span
							className="flex items-center gap-1 text-xs font-medium text-vscode-charts-red"
							data-testid={`change-card-file-error-${index}`}>
							<X className="size-3" aria-hidden />
							{t("chat:changeCard.rollbackFailed")}
						</span>
					</StandardTooltip>
				)
			default:
				return (
					<StandardTooltip content={t("chat:changeCard.rollbackFile")}>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("chat:changeCard.rollbackFile")}
							data-testid={`change-card-file-rollback-${index}`}
							onClick={() => setFileRollbacks((prev) => ({ ...prev, [path]: { status: "confirming" } }))}>
							<RotateCcw className="size-3.5" aria-hidden />
						</Button>
					</StandardTooltip>
				)
		}
	}

	const stepRollbackControls = () => {
		switch (stepRollback.status) {
			case "confirming":
				return (
					<span className="flex items-center gap-2">
						<span className="text-xs font-medium text-vscode-descriptionForeground">
							{t("chat:changeCard.rollbackWarning")}
						</span>
						<Button
							variant="primary"
							size="sm"
							onClick={requestStepRollback}
							data-testid="change-card-step-confirm">
							{t("chat:changeCard.confirm")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setStepRollback(IDLE)}
							data-testid="change-card-step-cancel">
							{t("chat:changeCard.cancel")}
						</Button>
					</span>
				)
			case "pending":
				return (
					<span
						className="flex items-center gap-2 text-xs text-vscode-descriptionForeground"
						data-testid="change-card-step-pending">
						<VSCodeProgressRing className="size-3.5" />
						{t("chat:changeCard.rollingBack")}
					</span>
				)
			case "success":
				return (
					<span
						className="flex items-center gap-1 text-xs font-medium text-vscode-charts-green"
						data-testid="change-card-step-success">
						<Check className="size-3" aria-hidden />
						{t("chat:changeCard.stepRolledBack")}
					</span>
				)
			case "error":
				return (
					<StandardTooltip content={stepRollback.error ?? t("chat:changeCard.rollbackFailed")}>
						<span
							className="flex items-center gap-1 text-xs font-medium text-vscode-charts-red"
							data-testid="change-card-step-error">
							<X className="size-3" aria-hidden />
							{t("chat:changeCard.rollbackFailed")}
						</span>
					</StandardTooltip>
				)
			default:
				return (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setStepRollback({ status: "confirming" })}
						data-testid="change-card-step-rollback">
						<RotateCcw className="size-3.5" aria-hidden />
						{t("chat:changeCard.rollbackStep")}
					</Button>
				)
		}
	}

	return (
		<div className="pt-2 pb-1">
			<div className="flex items-center gap-2">
				<FileDiff className="size-4 shrink-0" aria-hidden />
				<span className="text-sm font-medium" data-testid="change-card-header">
					{t("chat:changeCard.header", { count: card.totalFiles })}
				</span>
				<span className="flex-grow" />
				{stepRollbackControls()}
			</div>
			<div className="flex flex-col gap-1 pl-6 pb-2">
				{card.files.map((file, index) => (
					<div key={file.path} className="flex items-start gap-2">
						<div className="flex-grow min-w-0">
							{file.diff != null ? (
								<CodeAccordion
									path={file.path}
									code={file.diff}
									language="diff"
									isExpanded={expandedFiles.has(file.path)}
									onToggleExpand={() => toggleFile(file.path)}
									diffStats={{ added: file.additions, removed: file.deletions }}
								/>
							) : (
								<div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-vscode-panel-border bg-vscode-editor-background">
									<span className="whitespace-nowrap overflow-hidden text-ellipsis font-mono text-sm text-vscode-descriptionForeground">
										{formatPathTooltip(file.path)}
									</span>
									<span className="flex-grow" />
									{diffBadges(file.additions, file.deletions)}
								</div>
							)}
						</div>
						<div className="shrink-0 pt-1">{fileRollbackControls(file.path, index)}</div>
					</div>
				))}
			</div>
		</div>
	)
}
