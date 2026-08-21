import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { StandardTooltip } from "../ui"

interface TaskStatusBadgeProps {
	status: "delegated" | "interrupted"
	className?: string
}

/**
 * Small inline badge for a task's delegation status: a parent "delegated" and
 * waiting on a subtask, or a child that was "interrupted" mid-execution and
 * can be resumed rather than silently detached. See #559.
 */
export const TaskStatusBadge = ({ status, className }: TaskStatusBadgeProps) => {
	const { t } = useAppTranslation()

	const isInterrupted = status === "interrupted"
	const icon = isInterrupted ? "codicon-warning" : "codicon-sync"
	const label = isInterrupted ? t("history:interruptedTag") : t("history:delegatedTag")

	return (
		<StandardTooltip content={label}>
			<span
				data-testid={`task-status-badge-${status}`}
				className={cn(
					"inline-flex items-center gap-1",
					isInterrupted ? "text-vscode-editorWarning-foreground" : "text-vscode-descriptionForeground/60",
					className,
				)}>
				<span className={cn("codicon", icon, "text-[11px]")} />
				<span>{label}</span>
			</span>
		</StandardTooltip>
	)
}
