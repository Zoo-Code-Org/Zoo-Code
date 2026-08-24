import React from "react"
import { Brain, Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"

import { useExtensionState } from "@/context/ExtensionStateContext"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"

import { computeThinkingEffortDisplay } from "@/utils/thinkingEffort"

import { vscode } from "@/utils/vscode"

interface ThinkingEffortToggleProps {
	disabled?: boolean
	triggerClassName?: string
}

/**
 * DTE series 4/5: composer bottom-bar toggle for the task-local thinking
 * effort (icon + current value, next to the API config selector). The
 * trigger carries the same border/hover treatment as the sibling selectors
 *
 * The menu lists the model-advertised levels only; boolean/adaptive-class
 * models get the single "adaptive" soft-guidance entry. Selecting a level
 * posts `setTaskThinkingEffort` — task-local only, persisted settings never
 * change — and the displayed value always follows the authoritative
 * extension state (`taskThinkingEffort`), resetting on task switch.
 */
export const ThinkingEffortToggle = ({ disabled = false, triggerClassName = "" }: ThinkingEffortToggleProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const { t } = useAppTranslation()
	const { apiConfiguration, taskThinkingEffort } = useExtensionState()
	const { info: model } = useSelectedModel(apiConfiguration)

	const display = React.useMemo(
		() => computeThinkingEffortDisplay({ apiConfiguration, model, taskThinkingEffort }),
		[apiConfiguration, model, taskThinkingEffort],
	)

	// Hidden unless the selected model advertises per-request effort support.
	if (!display) {
		return null
	}

	const handleSelect = (level: string) => {
		vscode.postMessage({ type: "setTaskThinkingEffort", effort: level })
		setOpen(false)
	}

	const tooltipText = t("chat:thinkingEffort.chipTooltip", {
		effort: display.effort,
		source:
			display.source === "you"
				? t("chat:thinkingEffort.sourceYou")
				: display.source === "auto"
					? t("chat:thinkingEffort.sourceAuto")
					: t("chat:thinkingEffort.sourceDefault"),
	})

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="thinking-effort-toggle-root">
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger
					disabled={disabled}
					aria-label={t("chat:thinkingEffort.toggleTitle")}
					data-testid="thinking-effort-toggle-trigger"
					className={cn(
						"relative inline-flex items-center justify-center gap-1 whitespace-nowrap px-1.5 py-1",
						selectorTriggerClassName,
						!disabled && enabledSelectorTriggerClassName,
						disabled ? "opacity-50 cursor-not-allowed" : "",
						triggerClassName,
					)}>
					<Brain
						className={cn(
							"size-3.5 flex-shrink-0",
							display.source === "you" && "text-vscode-textLink-foreground",
						)}
					/>
					<span className="text-xs leading-none">{display.effort}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				container={portalContainer}
				className="z-50 w-44"
				align="start"
				data-testid="thinking-effort-toggle-menu">
				<div className="px-2.5 pt-2 pb-1 text-xs font-medium text-vscode-descriptionForeground">
					{t("chat:thinkingEffort.toggleTitle")}
				</div>
				{display.isAdaptiveClass && (
					<div className="px-2.5 pb-1.5 text-[11px] text-vscode-descriptionForeground">
						{t("chat:thinkingEffort.adaptiveHint")}
					</div>
				)}
				{display.supportedLevels.map((level) => (
					<button
						key={level}
						type="button"
						data-testid={`thinking-effort-option-${level}`}
						className="flex w-full items-center justify-between rounded px-2.5 py-1 text-left text-xs text-vscode-foreground hover:bg-vscode-list-hoverBackground focus:outline-none focus-visible:bg-vscode-list-hoverBackground"
						onClick={() => handleSelect(level)}>
						<span>{level}</span>
						{display.effort === level && <Check className="size-3 text-vscode-descriptionForeground" />}
					</button>
				))}
			</PopoverContent>
		</Popover>
	)
}
