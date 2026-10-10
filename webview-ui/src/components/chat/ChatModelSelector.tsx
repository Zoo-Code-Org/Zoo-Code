import { useMemo, useState, useCallback, useRef, type KeyboardEvent } from "react"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { isModelAllowedForOrganization, isProviderAllowAll } from "@roo-code/types"

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
	const searchInputRef = useRef<HTMLInputElement>(null)
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
	// The trigger label must reflect the persisted selection, never the transient search
	// text — otherwise typing in the popover search box rewrites the trigger/highlight.
	const displayValue = useMemo(() => {
		if (displayTransform && modelIdKey) {
			const storedValue = apiConfiguration?.[modelIdKey]
			return storedValue ? displayTransform(storedValue) : undefined
		}
		return selectedModelId || undefined
	}, [displayTransform, modelIdKey, apiConfiguration, selectedModelId])

	const filteredModelIds = useMemo(() => {
		if (!searchValue) return modelIds
		const q = searchValue.toLowerCase()
		return modelIds.filter((id) => id.toLowerCase().includes(q))
	}, [modelIds, searchValue])

	// Org policy permits an arbitrary/custom model id only when the provider is
	// explicitly `allowAll`; the options list is already filtered by `filterModels`.
	const canUseCustomModel = useMemo(
		() => isProviderAllowAll(organizationAllowList, provider),
		[organizationAllowList, provider],
	)

	// Defense-in-depth: reject a selection the org policy disallows, regardless
	// of how it was produced (option click, keyboard, or custom entry).
	const isModelAllowed = useCallback(
		(modelId: string): boolean => isModelAllowedForOrganization(organizationAllowList, provider, modelId),
		[organizationAllowList, provider],
	)

	const onSelect = useCallback(
		(modelId: string) => {
			if (!modelId || !modelIdKey || !apiConfiguration || !currentApiConfigName) {
				return
			}

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
		searchInputRef.current?.focus()
	}, [])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.nativeEvent.isComposing) return

		const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-option]"))
		const currentIndex = options.findIndex((option) => option === event.target)
		const isSearchInput = event.target === searchInputRef.current
		if (!isSearchInput && currentIndex === -1) return

		if (isSearchInput && event.key === "Enter") {
			event.preventDefault()
			options[0]?.click()
			return
		}

		let nextIndex: number
		switch (event.key) {
			case "ArrowDown":
				nextIndex = currentIndex + 1
				break
			case "ArrowUp":
				nextIndex = currentIndex === -1 ? options.length - 1 : currentIndex - 1
				break
			case "Home":
			case "End":
				if (isSearchInput) return
				nextIndex = event.key === "Home" ? 0 : options.length - 1
				break
			default:
				return
		}
		event.preventDefault()
		if (nextIndex < 0 || nextIndex >= options.length) {
			searchInputRef.current?.focus()
		} else {
			options[nextIndex]?.focus()
		}
	}

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="chat-model-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled || !modelIdKey || !currentApiConfigName}
					data-testid="chat-model-selector-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						disabled || !modelIdKey || !currentApiConfigName
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
				<div className="flex flex-col w-full" onKeyDown={onKeyDown}>
					<div className="relative p-2 border-b border-vscode-dropdown-border">
						<input
							ref={searchInputRef}
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
									aria-label={t("chat:clearSearch")}
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
								<button
									type="button"
									data-model-option
									key={modelId}
									onClick={() => onSelect(modelId)}
									data-testid={`chat-model-option-${modelId}`}
									className={cn(
										"w-full text-left px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2",
										"hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder focus-visible:-outline-offset-1",
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

					{searchValue && canUseCustomModel && !modelIds.includes(searchValue) && (
						<button
							type="button"
							data-model-option
							data-testid="chat-model-use-custom"
							onClick={() => onSelect(searchValue)}
							className="w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-vscode-list-hoverBackground border-t border-vscode-input-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder focus-visible:-outline-offset-1">
							{t("chat:useCustomModel", { modelId: searchValue })}
						</button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
