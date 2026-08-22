/*
Reasoning Effort selector for the chat input bottom bar.

Sits beside the API configuration profile picker so the active model's reasoning
effort can be changed without opening Settings. It reads and writes the same
`reasoningEffort` / `enableReasoningEffort` fields of the active profile that the
Providers settings page edits (persisted via the `upsertApiConfiguration`
message), so both controls stay in sync through the extension state broadcast.

Option computation is shared with the settings selectors via
`getReasoningEffortSelection`, and the Ollama model-info normalization is shared
via `getOllamaReasoningModelInfo`, so the values shown here always match Settings
and both surfaces can't drift. The fetcher's capability array is passed through
verbatim (it includes "disable" for models that honor think: false and omits it
for models that don't, e.g. gpt-oss); the fallback synthesizes
[disable, low, medium, high] when no model info has loaded yet.
*/

import { useCallback, useMemo, useRef, useState } from "react"

import type { ModelInfo } from "@roo-code/types/model"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { cn } from "@src/lib/utils"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import {
	getOllamaReasoningModelInfo,
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
	const listRef = useRef<HTMLDivElement>(null)

	// Build the modelInfo through the same shared Ollama normalization the
	// settings page uses, so the chat dropdown lists exactly the same options
	// as the settings dropdown. The fetcher's advertised array is passed through
	// verbatim; the fallback synthesizes [disable, low, medium, high] when no
	// model info has loaded yet so the selector can render immediately.
	const modelInfo = useMemo<ModelInfo | undefined>(() => {
		if (provider === providerIdentifiers.ollama) {
			return getOllamaReasoningModelInfo(selectedModelInfo)
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
			// selector never flips it. Picking "None" (the "disable" option) in
			// chat keeps enableReasoningEffort as-is and stores
			// reasoningEffort: "disable". `getOllamaThinkParam()` gates the think
			// param on `enableReasoningEffort === true` first, so when that flag
			// stays on it still emits no think param only if reasoningEffort maps
			// to off — but the chat selector is a soft toggle that does not change
			// the flag, so the authoritative on/off state remains the settings
			// checkbox. There is no separate `reasoning: "none"` field; Ollama has
			// no native "none" string level, and "disable" maps to think: false.
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

	// Keyboard navigation for the option list. The container acts as a listbox
	// (role="listbox") and each option is a native <button> with role="option",
	// so Tab reaches the first option and Arrow Up/Down moves between them; Enter
	// or Space activates the focused option. This keeps the selector usable for
	// keyboard-only and screen-reader users instead of the previous
	// non-focusable <div onClick> rows.
	const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
		const buttons = listRef.current
			? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('button[role="option"]'))
			: []
		if (buttons.length === 0) {
			return
		}
		const currentIndex = buttons.findIndex((b) => b === document.activeElement)
		if (event.key === "ArrowDown") {
			event.preventDefault()
			const next = buttons[currentIndex + 1] ?? buttons[0]
			next.focus()
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			const prev = buttons[currentIndex - 1] ?? buttons[buttons.length - 1]
			prev.focus()
		} else if (event.key === "Home") {
			event.preventDefault()
			buttons[0].focus()
		} else if (event.key === "End") {
			event.preventDefault()
			buttons[buttons.length - 1].focus()
		}
	}, [])

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
					<div
						ref={listRef}
						role="listbox"
						aria-label={title}
						tabIndex={-1}
						onKeyDown={handleListKeyDown}
						className="max-h-[300px] overflow-y-auto py-1">
						{availableOptions.map((option) => {
							const selected = option === currentReasoningEffort
							return (
								<button
									key={option}
									type="button"
									role="option"
									aria-selected={selected}
									data-testid={`reasoning-effort-option-${option}`}
									onClick={() => handleSelect(option)}
									className={cn(
										"w-full text-left px-3 py-1.5 text-sm flex items-center",
										"focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder",
										"hover:bg-vscode-list-hoverBackground",
										selected &&
											"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
									)}>
									<span className="flex-1 min-w-0 truncate">
										{t(getReasoningEffortTranslationKey(option))}
									</span>
									{selected && (
										<div className="size-5 p-1 flex items-center justify-center">
											<span className="codicon codicon-check text-xs" />
										</div>
									)}
								</button>
							)
						})}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
