import React, { useContext } from "react"
import type { HistoryItem } from "@roo-code/types"
import { formatDateTime, formatTimeAgo } from "@/utils/format"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { CopyButton } from "./CopyButton"
import { ExportButton } from "./ExportButton"
import { DeleteButton } from "./DeleteButton"
import { RenameButton } from "./RenameButton"
import { StandardTooltip } from "../ui/standard-tooltip"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Split } from "lucide-react"
import { TaskStatusBadge } from "./TaskStatusBadge"

export interface TaskItemFooterProps {
	item: HistoryItem
	variant: "compact" | "full"
	isSelectionMode?: boolean
	isSubtask?: boolean
	onDelete?: (taskId: string) => void
	onRename?: () => void
}

const TaskItemFooter: React.FC<TaskItemFooterProps> = ({
	item,
	variant,
	isSelectionMode = false,
	isSubtask = false,
	onDelete,
	onRename,
}) => {
	const { t } = useAppTranslation()
	// Optional read: this leaf renders standalone (tests, previews) without a provider.
	const ext = useContext(ExtensionStateContext)
	const timeFormat = ext?.timeFormat
	const dateFormat = ext?.dateFormat
	const showRelativeTimes = ext?.showRelativeTimes ?? true

	return (
		<div className="text-xs text-vscode-descriptionForeground flex justify-between items-center">
			<div className="flex gap-1 items-center text-vscode-descriptionForeground/60">
				{/* Subtask tag */}
				{isSubtask && (
					<>
						<Split className="size-3" />
						<span>{t("history:subtaskTag")}</span>
						<span>·</span>
					</>
				)}
				{/* Delegation status (delegated parent waiting on a child, or interrupted child) */}
				{(item.status === "delegated" || item.status === "interrupted") && (
					<>
						<TaskStatusBadge status={item.status} />
						<span>·</span>
					</>
				)}
				{/* Datetime. A relative time carries the full date and time in a tooltip; the absolute time already
				    shows it, so it gets no tooltip that would only repeat it. */}
				{showRelativeTimes ? (
					<StandardTooltip content={formatDateTime(item.ts, timeFormat, dateFormat)}>
						<span className="first-letter:uppercase">{formatTimeAgo(item.ts)}</span>
					</StandardTooltip>
				) : (
					<span className="first-letter:uppercase">{formatDateTime(item.ts, timeFormat, dateFormat)}</span>
				)}

				{/* Cost */}
				{!!item.totalCost && (
					<>
						<span>·</span>
						<span className="flex items-center" data-testid="cost-footer-compact">
							{"$" + item.totalCost.toFixed(2)}
						</span>
					</>
				)}
			</div>

			{/* Action Buttons for non-compact view */}
			{!isSelectionMode && (
				<div className="flex flex-row gap-0 -mx-1.5 items-center text-vscode-descriptionForeground/60 hover:text-vscode-descriptionForeground opacity-0 group-hover:opacity-100">
					{variant === "full" && onRename && <RenameButton onRename={onRename} />}
					<CopyButton itemTask={item.task} />
					{variant === "full" && <ExportButton itemId={item.id} />}
					{onDelete && <DeleteButton itemId={item.id} onDelete={onDelete} />}
				</div>
			)}
		</div>
	)
}

export default TaskItemFooter
