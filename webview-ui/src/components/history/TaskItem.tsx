import { memo } from "react"
import { ArrowRight, Folder } from "lucide-react"
import type { DisplayHistoryItem } from "./types"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { StandardTooltip } from "../ui"

import TaskItemFooter from "./TaskItemFooter"
import { PinButton } from "./PinButton"

interface TaskItemProps {
	item: DisplayHistoryItem
	variant: "compact" | "full"
	showWorkspace?: boolean
	hasSubtasks?: boolean
	isSelectionMode?: boolean
	isSelected?: boolean
	onToggleSelection?: (taskId: string, isSelected: boolean) => void
	onDelete?: (taskId: string) => void
	/** Whether to show the pin toggle button. */
	showPin?: boolean
	/** Whether the task is currently pinned. */
	isPinned?: boolean
	/** Whether pinning is currently allowed. */
	canPin?: boolean
	/** Called when the pin button is toggled. */
	onTogglePin?: () => void
	className?: string
}

const TaskItem = ({
	item,
	variant,
	showWorkspace = false,
	hasSubtasks = false,
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	onDelete,
	showPin = false,
	isPinned = false,
	canPin = false,
	onTogglePin,
	className,
}: TaskItemProps) => {
	const handleClick = () => {
		if (isSelectionMode && onToggleSelection) {
			onToggleSelection(item.id, !isSelected)
		} else {
			vscode.postMessage({ type: "showTaskWithId", text: item.id })
		}
	}

	const isCompact = variant === "compact"

	return (
		<div
			data-testid={`task-item-${item.id}`}
			className={cn(
				"cursor-pointer group relative overflow-hidden",
				"text-vscode-foreground/80 hover:text-vscode-foreground transition-colors",
				hasSubtasks ? "rounded-t-xl" : "rounded-xl",
				className,
			)}
			onClick={handleClick}>
			<div className={(!isCompact && isSelectionMode ? "pl-3 pb-3" : "pl-4") + " flex gap-3 px-3 pt-3 pb-1"}>
				{/* Selection checkbox - only in full variant */}
				{!isCompact && isSelectionMode && (
					<div
						className="task-checkbox mt-1"
						onClick={(e) => {
							e.stopPropagation()
						}}>
						<Checkbox
							checked={isSelected}
							onCheckedChange={(checked: boolean) => onToggleSelection?.(item.id, checked === true)}
							variant="description"
						/>
					</div>
				)}

				<div className="flex-1 min-w-0">
					<div className="flex items-start gap-1">
						{item.highlight ? (
							<div
								className={cn(
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-light text-ellipsis line-clamp-3",
									{
										"text-base": !isCompact,
									},
									!isCompact && isSelectionMode ? "mb-1" : "",
								)}
								data-testid="task-content"
								dangerouslySetInnerHTML={{ __html: item.highlight }}
							/>
						) : (
							<div
								className={cn(
									"flex-1 min-w-0 overflow-hidden whitespace-pre-wrap font-light text-ellipsis line-clamp-3",
									{
										"text-base": !isCompact,
									},
									!isCompact && isSelectionMode ? "mb-1" : "",
								)}
								data-testid="task-content">
								<StandardTooltip content={item.task}>
									<span>{item.task}</span>
								</StandardTooltip>
							</div>
						)}

						<div className="flex items-center gap-0 shrink-0">
							{showPin && onTogglePin && (
								<PinButton
									isPinned={isPinned}
									canPin={canPin}
									onToggle={onTogglePin}
									size="sm"
									data-testid="task-pin-button"
								/>
							)}
							{/* Arrow icon that appears on hover */}
							<ArrowRight className="size-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
						</div>
					</div>

					{showWorkspace && item.workspace && (
						<div className="flex items-center font-mono gap-1 text-vscode-descriptionForeground text-xs mt-1">
							<Folder className="size-3" />
							<span>{item.workspace}</span>
						</div>
					)}

					<TaskItemFooter
						item={item}
						variant={variant}
						isSelectionMode={isSelectionMode}
						isSubtask={item.isSubtask}
						onDelete={onDelete}
					/>
				</div>
			</div>
		</div>
	)
}

export default memo(TaskItem)
