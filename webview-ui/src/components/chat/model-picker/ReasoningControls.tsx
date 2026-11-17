import { Brain } from "lucide-react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import type { ReasoningOption, ReasoningSelection } from "./reasoning"

export function ReasoningControls({
	selection,
	disabled,
	onSelect,
}: {
	selection: ReasoningSelection
	disabled: boolean
	onSelect: (effort: ReasoningOption) => void
}) {
	const { t } = useAppTranslation()
	if (!selection.supportedOptions.length) return null
	return (
		<div className="flex shrink-0 flex-col gap-1.5 border-t border-vscode-dropdown-border p-3">
			<div className="flex items-center gap-1.5 text-xs text-vscode-descriptionForeground">
				<Brain aria-hidden="true" className="size-3" />
				{t("chat:modelPicker.reasoningEffort")}
			</div>
			<div role="group" aria-label={t("chat:modelPicker.reasoningEffort")} className="flex flex-wrap gap-1">
				{selection.supportedOptions.map((effort) => (
					<button
						key={effort}
						type="button"
						disabled={disabled}
						aria-pressed={selection.currentEffort === effort}
						onClick={() => onSelect(effort)}
						className={cn(
							"cursor-pointer rounded border border-vscode-input-border px-2 py-1 text-[11px] focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:opacity-50",
							selection.currentEffort === effort
								? "bg-vscode-button-background text-vscode-button-foreground"
								: "bg-transparent text-vscode-foreground hover:bg-vscode-list-hoverBackground",
						)}>
						{effort === "disable" ? t("chat:modelPicker.off") : t(`chat:modelPicker.effort.${effort}`)}
					</button>
				))}
			</div>
		</div>
	)
}
