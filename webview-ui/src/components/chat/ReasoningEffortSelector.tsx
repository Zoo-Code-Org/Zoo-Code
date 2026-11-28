import React from "react"
import { Check } from "lucide-react"

import { type ProviderSettings, type ModelInfo, type ReasoningEffortSetting } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"

// Same capability semantics as the settings ThinkingBudget control:
// - boolean true → the standard effort ladder plus "Off" (unless the effort is required)
// - capability array → exactly those values (they may include "disable"/"none")
// - anything else (budget-only, binary, unsupported) → no quick switching
function getSupportedEfforts(modelInfo: ModelInfo): ReadonlyArray<ReasoningEffortSetting> | null {
	const supports = modelInfo.supportsReasoningEffort

	if (supports === true) {
		return modelInfo.requiredReasoningEffort ? ["low", "medium", "high"] : ["disable", "low", "medium", "high"]
	}

	if (Array.isArray(supports)) {
		return supports.length > 0 ? supports : null
	}

	return null
}

// Mirrors `shouldUseReasoningEffort` (src/shared/api.ts) for display: what the
// active configuration actually sends right now. The chat override is checked
// first, exactly like the API layer's `withReasoningEffortOverride` fold.
// Returns `undefined` when no reasoning effort is sent ("Off").
function resolveActiveEffort(
	apiConfiguration: ProviderSettings,
	modelInfo: ModelInfo,
	supported: ReadonlyArray<ReasoningEffortSetting>,
): ReasoningEffortSetting | undefined {
	const override = apiConfiguration.reasoningEffortOverride

	if (override !== undefined && supported.includes(override)) {
		return override === "disable" ? undefined : override
	}

	if (apiConfiguration.enableReasoningEffort === false) return undefined

	const selected = apiConfiguration.reasoningEffort ?? modelInfo.reasoningEffort

	if (!selected || selected === "disable") return undefined

	return supported.includes(selected) ? selected : undefined
}

interface ReasoningEffortSelectorProps {
	apiConfiguration: ProviderSettings
	disabled?: boolean
	title: string
	triggerClassName?: string
}

export const ReasoningEffortSelector = ({
	apiConfiguration,
	disabled = false,
	title,
	triggerClassName = "",
}: ReasoningEffortSelectorProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const { t } = useAppTranslation()
	const { currentApiConfigName } = useExtensionState()

	const { provider, info: modelInfo } = useSelectedModel(apiConfiguration)

	const supportedEfforts = React.useMemo(() => (modelInfo ? getSupportedEfforts(modelInfo) : null), [modelInfo])

	const effortLabel = React.useCallback(
		(effort: ReasoningEffortSetting) => {
			switch (effort) {
				case "disable":
					return t("chat:reasoningEffortSelector.off")
				case "none":
				case "minimal":
				case "low":
				case "medium":
				case "high":
				case "xhigh":
				case "max":
					return t(`settings:providers.reasoningEffort.${effort}`)
			}
		},
		[t],
	)

	if (!modelInfo || !supportedEfforts || !provider || !currentApiConfigName) {
		return null
	}

	const override = apiConfiguration.reasoningEffortOverride
	const overrideActive = override !== undefined && supportedEfforts.includes(override)
	const activeEffort = resolveActiveEffort(apiConfiguration, modelInfo, supportedEfforts)

	const triggerLabel = activeEffort !== undefined ? effortLabel(activeEffort) : t("chat:reasoningEffortSelector.off")

	const handleSelect = (effort: ReasoningEffortSetting | null) => {
		vscode.postMessage({
			type: "updateReasoningEffortOverride",
			text: currentApiConfigName,
			values: { expectedProvider: provider, effort },
		})
		setOpen(false)
	}

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="reasoning-effort-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="reasoning-effort-selector-trigger"
					className={cn(
						"inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						disabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
						triggerClassName,
					)}>
					<span className="truncate">{triggerLabel}</span>
					{overrideActive && (
						<span
							data-testid="reasoning-effort-override-indicator"
							aria-label={t("chat:reasoningEffortSelector.overrideActive")}
							className="ml-1 inline-block size-1.5 shrink-0 rounded-full"
							style={{ background: "var(--vscode-charts-orange)" }}
						/>
					)}
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="w-[240px] p-0 overflow-hidden">
				<div className="flex flex-col w-full">
					<div className="p-3 border-b border-vscode-dropdown-border">
						<p className="m-0 text-xs text-vscode-descriptionForeground">
							{t("chat:reasoningEffortSelector.description")}
						</p>
					</div>
					<div className="py-1">
						<button
							type="button"
							onClick={() => handleSelect(null)}
							aria-current={!overrideActive}
							className={cn(
								"w-full px-3 py-1.5 text-sm text-left cursor-pointer flex items-center",
								"bg-transparent border-0 text-vscode-foreground",
								"focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder",
								"hover:bg-vscode-list-hoverBackground",
								!overrideActive
									? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
									: "",
							)}
							data-testid="reasoning-effort-item-default">
							<div className="flex-1 min-w-0">
								<div className="truncate">{t("chat:reasoningEffortSelector.default")}</div>
							</div>
							{!overrideActive && <Check className="ml-auto size-4 p-0.5" />}
						</button>
						{supportedEfforts.map((effort) => {
							const isSelected = overrideActive && override === effort
							return (
								<button
									type="button"
									key={effort}
									onClick={() => handleSelect(effort)}
									aria-current={isSelected}
									className={cn(
										"w-full px-3 py-1.5 text-sm text-left cursor-pointer flex items-center",
										"bg-transparent border-0 text-vscode-foreground",
										"focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder",
										"hover:bg-vscode-list-hoverBackground",
										isSelected
											? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
											: "",
									)}
									data-testid={`reasoning-effort-item-${effort}`}>
									<div className="flex-1 min-w-0">
										<div className="truncate">{effortLabel(effort)}</div>
									</div>
									{isSelected && <Check className="ml-auto size-4 p-0.5" />}
								</button>
							)
						})}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
