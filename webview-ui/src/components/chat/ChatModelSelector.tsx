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

	// Gate arbitrary model ids against the organization allow-list. The webview
	// is not a security boundary, but this keeps the UI from offering a custom
	// model that the extension host would reject on save.
	const isModelAllowed = useCallback(
		(modelId: string): boolean => {
			if (!organizationAllowList || organizationAllowList.allowAll) {
				return true
			}
			if (!provider) {
				return false
			}
			const providerConfig = organizationAllowList.providers[provider]
			if (!providerConfig) {
				return false
			}
			if (providerConfig.allowAll) {
				return true
			}
			return providerConfig.models?.includes(modelId) ?? false
		},
		[organizationAllowList, provider],
	)

	// Only offer a custom (non-listed) model when the allow-list permits that
	// exact model id for the active provider.
	const customModelAllowed = useMemo(
		() => (searchValue ? isModelAllowed(searchValue) : false),
		[searchValue, isModelAllowed],
	)

	// Resolve the display value (custom transform for compound config values like VSCode LM).
	const displayValue = useMemo(() => {
		if (displayTransform && modelIdKey) {
			const storedValue = apiConfiguration?.[modelIdKey]
			return storedValue ? displayTransform(storedValue) : undefined
		}
		// Only reflect the saved model in the trigger label (and the row
		// highlight); fall back to undefined so the default/placeholder shows
		// instead of the in-progress search text.
		return selectedModelId || undefined
	}, [displayTransform, modelIdKey, apiConfiguration, selectedModelId])

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

			// Defense in depth: never persist a model the allow-list forbids,
			// even if a caller bypasses the rendered list (e.g. custom search).
			if (!isModelAllowed(modelId)) {
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
		[modelIdKey, apiConfiguration, valueTransform, currentApiConfigName, isModelAllowed],
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
								<button
									type="button"
									aria-label="Clear search"
									data-testid="chat-model-search-clear"
									onClick={onClearSearch}
									className="codicon codicon-close text-vscode-input-foreground opacity-50 hover:opacity-100 text-xs cursor-pointer bg-transparent border-none p-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder"
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
								<button
									key={modelId}
									type="button"
									onClick={() => onSelect(modelId)}
									data-testid={`chat-model-option-${modelId}`}
									className={cn(
										"w-full text-left bg-transparent border-none px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2",
										"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
										"hover:bg-vscode-list-hoverBackground",
										modelId === displayValue &&
											"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
									)}>
									<span className="flex-1 min-w-0 truncate" title={modelId}>
										{modelId}
									</span>
									{modelId === displayValue && <span className="codicon codicon-check text-xs" />}
								</button>
							))}
						</div>
					)}

					{searchValue && customModelAllowed && !modelIds.includes(searchValue) && (
						<button
							type="button"
							data-testid="chat-model-use-custom"
							onClick={() => onSelect(searchValue)}
							className="w-full text-left bg-transparent border-none px-3 py-1.5 text-sm cursor-pointer hover:bg-vscode-list-hoverBackground border-t border-vscode-input-border focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset">
							{t("chat:useCustomModel", { modelId: searchValue })}
						</button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
