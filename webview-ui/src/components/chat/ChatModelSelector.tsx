import { useMemo, useState, useCallback } from "react"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { filterModels } from "@/components/settings/utils/organizationFilters"
import { useChatModelSelector } from "./hooks/useChatModelSelector"

interface ChatModelSelectorProps {
	disabled?: boolean
	title: string
	triggerClassName?: string
}

export const ChatModelSelector = ({ disabled = false, title, triggerClassName = "" }: ChatModelSelectorProps) => {
	const { t } = useAppTranslation()
	const { apiConfiguration, organizationAllowList, currentApiConfigName } = useExtensionState()
	const { id: selectedModelId } = useSelectedModel(apiConfiguration)
	const { provider, models, modelIdKey, defaultModelId, isLoading, valueTransform, displayTransform } =
		useChatModelSelector()

	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const portalContainer = useRooPortal("roo-portal")

	// Filter deprecated models but always keep the currently selected one visible.
	const modelIds = useMemo(() => {
		const filteredModels = filterModels(models, provider, organizationAllowList)
		const available = Object.entries(filteredModels ?? {})
			.filter(([modelId, modelInfo]) => {
				if (modelId === selectedModelId) return true
				return !modelInfo.deprecated
			})
			.map(([modelId]) => modelId)
			.sort((a, b) => a.localeCompare(b))
		return available
	}, [models, provider, organizationAllowList, selectedModelId])

	// Resolve the display value (custom transform for compound config values like VSCode LM).
	const displayValue = useMemo(() => {
		if (displayTransform && modelIdKey) {
			const storedValue = apiConfiguration?.[modelIdKey]
			return storedValue ? displayTransform(storedValue) : undefined
		}
		return selectedModelId || (searchValue ? searchValue : undefined)
	}, [displayTransform, modelIdKey, apiConfiguration, selectedModelId, searchValue])

	const filteredModelIds = useMemo(() => {
		if (!searchValue) return modelIds
		const q = searchValue.toLowerCase()
		return modelIds.filter((id) => id.toLowerCase().includes(q))
	}, [modelIds, searchValue])

	const onSelect = useCallback(
		(modelId: string) => {
			if (!modelId || !modelIdKey || !apiConfiguration) {
				return
			}

			setOpen(false)
			setSearchValue("")

			// Transform the model id for storage if needed (e.g. VSCode LM selector object).
			const valueToStore = valueTransform ? valueTransform(modelId) : modelId

			// Persist the change to the current API configuration profile. The
			// backend will save the profile, activate it and broadcast the
			// updated apiConfiguration back to the webview.
			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration: {
					...apiConfiguration,
					[modelIdKey]: valueToStore,
				},
			})
		},
		[modelIdKey, apiConfiguration, valueTransform, currentApiConfigName],
	)

	const onClearSearch = useCallback(() => {
		setSearchValue("")
	}, [])

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="chat-model-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled || !modelIdKey}
					data-testid="chat-model-selector-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						disabled || !modelIdKey
							? "opacity-50 cursor-not-allowed"
							: "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						triggerClassName,
					)}>
					<span className="truncate max-w-[140px]">
						{isLoading ? "…" : displayValue || defaultModelId || t("chat:selectModel")}
					</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[300px]">
				<div className="flex flex-col w-full">
					<div className="relative p-2 border-b border-vscode-dropdown-border">
						<input
							aria-label={t("chat:searchModel")}
							value={searchValue}
							onChange={(e) => setSearchValue(e.target.value)}
							placeholder={t("chat:searchModel")}
							className="w-full h-8 px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-0"
							autoFocus
						/>
						{searchValue.length > 0 && (
							<div className="absolute right-4 top-0 bottom-0 flex items-center justify-center">
								<span
									className="codicon codicon-close text-vscode-input-foreground opacity-50 hover:opacity-100 text-xs cursor-pointer"
									onClick={onClearSearch}
								/>
							</div>
						)}
					</div>

					{modelIds.length === 0 && !isLoading && (
						<div className="py-2 px-3 text-sm text-vscode-foreground/70">{t("chat:modelListEmpty")}</div>
					)}

					{modelIds.length > 0 && (
						<div className="max-h-[300px] overflow-y-auto">
							{filteredModelIds.map((modelId) => (
								<div
									key={modelId}
									onClick={() => onSelect(modelId)}
									data-testid={`chat-model-option-${modelId}`}
									className={cn(
										"px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2",
										"hover:bg-vscode-list-hoverBackground",
										modelId === displayValue &&
											"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
									)}>
									<span className="flex-1 min-w-0 truncate" title={modelId}>
										{modelId}
									</span>
									{modelId === displayValue && <span className="codicon codicon-check text-xs" />}
								</div>
							))}
						</div>
					)}

					{searchValue && !modelIds.includes(searchValue) && (
						<div
							data-testid="chat-model-use-custom"
							onClick={() => onSelect(searchValue)}
							className="px-3 py-1.5 text-sm cursor-pointer hover:bg-vscode-list-hoverBackground border-t border-vscode-input-border">
							{t("chat:useCustomModel", { modelId: searchValue })}
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
