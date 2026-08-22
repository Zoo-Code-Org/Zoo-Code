/*
Reasoning Effort selector for the chat input bottom bar.

Sits beside the API configuration profile picker so the active model's reasoning
effort can be changed without opening Settings. It reads and writes the same
`reasoningEffort` / `enableReasoningEffort` fields of the active profile that the
Providers settings page edits (persisted via the `upsertApiConfiguration`
message), so both controls stay in sync through the extension state broadcast.

Option computation is shared with the settings selectors via
`getReasoningEffortSelection`, so the values shown here always match Settings.
For Ollama, the synthesized model info prepends "none" so the dropdown always
lists None alongside the model's advertised effort levels (e.g.
low/medium/high/max for cloud ollama models).
*/

import { useCallback, useMemo, useState } from "react"

import { type ModelInfo, ollamaDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import {
	getReasoningEffortSelection,
	getReasoningEffortTranslationKey,
	type ReasoningEffortOption,
} from "@src/utils/reasoning-effort"
import { vscode } from "@src/utils/vscode"

interface ReasoningEffortSelectorProps {
	disabled?: boolean
	triggerClassName?: string
}

export const ReasoningEffortSelector = ({ disabled = false, triggerClassName = "" }: ReasoningEffortSelectorProps) => {
	const { t } = useAppTranslation()
	const { apiConfiguration, currentApiConfigName } = useExtensionState()
	const { provider, info: selectedModelInfo } = useSelectedModel(apiConfiguration)
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	// Build the modelInfo the same way the Ollama settings page does, so the
	// chat dropdown lists exactly the same options as the settings dropdown.
	// For Ollama, prepend "none" so users can pick "None" alongside the model's
	// advertised effort levels. For other providers, fall through to whatever
	// the selected model advertises (the selector stays hidden when nothing
	// advertises `supportsReasoningEffort`).
	const modelInfo = useMemo<ModelInfo | undefined>(() => {
		if (provider === providerIdentifiers.ollama) {
			if (selectedModelInfo?.supportsReasoningEffort) {
				const advertised = selectedModelInfo.supportsReasoningEffort
				return {
					...selectedModelInfo,
					supportsReasoningEffort: Array.isArray(advertised)
						? advertised.includes("none")
							? advertised
							: (["none", ...advertised] as typeof advertised)
						: advertised,
				}
			}

			// No advertised info yet (router models still loading, or local model
			// without thinking metadata). Fall back to a synthesized modelInfo
			// exposing the levels Ollama's native `think` parameter supports so
			// the selector can render immediately.
			return { ...ollamaDefaultModelInfo, supportsReasoningEffort: ["none", "low", "medium", "high"] }
		}

		return selectedModelInfo
	}, [provider, selectedModelInfo])

	const { isReasoningEffortSupported, availableOptions, currentReasoningEffort } = getReasoningEffortSelection(
		apiConfiguration,
		modelInfo,
	)

	const handleSelect = useCallback(
		(option: ReasoningEffortOption) => {
			if (!currentApiConfigName || !apiConfiguration) {
				return
			}

			// Write only `reasoningEffort`. The Enable Thinking checkbox in the
			// settings page owns `enableReasoningEffort` independently, so the chat
			// selector never flips it. Picking "None" in chat keeps
			// enableReasoningEffort as-is and stores reasoningEffort: "none",
			// which `getOllamaThinkParam()` translates to `think: true` with
			// `reasoning: "none"` (an explicit "no reasoning level" choice that
			// ollama accepts and that the settings dropdown shows verbatim).
			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration: {
					...apiConfiguration,
					reasoningEffort: option,
				},
			})
			setOpen(false)
		},
		[apiConfiguration, currentApiConfigName],
	)

	// The Enable Thinking checkbox in the settings page owns
	// `enableReasoningEffort`; the chat selector only edits `reasoningEffort`
	// (it never flips the flag). Mirror that gate here so the selector hides
	// whenever thinking is unticked, keeping the chat bar and the settings
	// checkbox in sync. Models with `requiredReasoningEffort` (reasoning is
	// mandatory) always render the selector, matching the settings page.
	if (
		!isReasoningEffortSupported ||
		(apiConfiguration?.enableReasoningEffort !== true && !modelInfo?.requiredReasoningEffort)
	) {
		return null
	}

	const title = t("settings:providers.reasoningEffort.label")

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="reasoning-effort-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="reasoning-effort-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						disabled
							? "opacity-50 cursor-not-allowed"
							: "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						triggerClassName,
					)}>
					<span className="truncate">{t(getReasoningEffortTranslationKey(currentReasoningEffort))}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[180px]">
				<div className="flex flex-col w-full">
					<div className="p-3 border-b border-vscode-dropdown-border">
						<p className="text-xs text-vscode-descriptionForeground m-0">{title}</p>
					</div>
					<div className="max-h-[300px] overflow-y-auto py-1">
						{availableOptions.map((option) => (
							<div
								key={option}
								data-testid={`reasoning-effort-option-${option}`}
								onClick={() => handleSelect(option)}
								className={cn(
									"px-3 py-1.5 text-sm cursor-pointer flex items-center",
									"hover:bg-vscode-list-hoverBackground",
									option === currentReasoningEffort &&
										"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
								)}>
								<span className="flex-1 min-w-0 truncate">
									{t(getReasoningEffortTranslationKey(option))}
								</span>
								{option === currentReasoningEffort && (
									<div className="size-5 p-1 flex items-center justify-center">
										<span className="codicon codicon-check text-xs" />
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
