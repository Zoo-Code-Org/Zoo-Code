import React from "react"
import { Fzf } from "fzf"
import { Check, X } from "lucide-react"

import {
	type ProviderSettings,
	type ProviderName,
	type ModelInfo,
	providerIdentifiers,
	isRetiredProvider,
} from "@roo-code/types"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	isStaticModelProvider,
	getStaticModelsForProvider,
	getProviderModelConfig,
	handleModelChangeSideEffects,
} from "@/components/settings/utils/providerModelConfig"
import { filterModels } from "@/components/settings/utils/organizationFilters"

import { IconButton } from "./IconButton"

const SEARCH_THRESHOLD = 6

const BEDROCK_CUSTOM_ARN_MODEL_ID = "custom-arn"

// Providers whose model can only be picked via a bespoke Settings UI
// (freeform text, local model discovery, or a compound vendor/family selector)
// rather than a simple id list.
const UNSUPPORTED_QUICK_PICK_PROVIDERS: ProviderName[] = [
	providerIdentifiers.openai,
	providerIdentifiers.ollama,
	providerIdentifiers.lmstudio,
	providerIdentifiers.vscodeLm,
]

function getModelIdField(provider: ProviderName): string | undefined {
	return getProviderModelConfig(provider)?.field
}

function useModelListForProvider(provider: ProviderName | undefined, apiConfiguration?: ProviderSettings) {
	const isStatic = provider ? isStaticModelProvider(provider) : false
	const field = provider ? getModelIdField(provider) : undefined
	const isUnsupported = !provider || !field || UNSUPPORTED_QUICK_PICK_PROVIDERS.includes(provider)
	const isRouterProvider = !isStatic && !isUnsupported

	const routerModels = useRouterModels({ provider, enabled: isRouterProvider })
	const routerModelsData = routerModels.data as Record<string, Record<string, ModelInfo>> | undefined
	const isLoading = isRouterProvider && routerModels.isLoading

	return React.useMemo(() => {
		if (!provider || !field || isUnsupported) {
			return { isUnsupported: true as const, field: undefined, models: null, isLoading: false }
		}

		const models = isStatic
			? getStaticModelsForProvider(provider, undefined, apiConfiguration)
			: (routerModelsData?.[provider] ?? null)

		return { isUnsupported: false as const, field, models, isLoading }
	}, [provider, field, isUnsupported, isStatic, apiConfiguration, routerModelsData, isLoading])
}

interface ModelSelectorProps {
	apiConfiguration?: ProviderSettings
	disabled?: boolean
	title: string
	triggerClassName?: string
}

export const ModelSelector = ({
	apiConfiguration,
	disabled = false,
	title,
	triggerClassName = "",
}: ModelSelectorProps) => {
	const [open, setOpen] = React.useState(false)
	const [searchValue, setSearchValue] = React.useState("")
	const searchInputRef = React.useRef<HTMLInputElement>(null)
	const portalContainer = useRooPortal("roo-portal")
	const { t } = useAppTranslation()
	const { organizationAllowList, currentApiConfigName } = useExtensionState()

	const providerRaw = apiConfiguration?.apiProvider || providerIdentifiers.openrouter
	const provider: ProviderName | undefined = isRetiredProvider(providerRaw) ? undefined : providerRaw

	const { id: selectedModelId, info: selectedModelInfo } = useSelectedModel(apiConfiguration)
	const { isUnsupported, field, models, isLoading } = useModelListForProvider(provider, apiConfiguration)

	const filteredModelRecord = React.useMemo(
		() => filterModels(models, provider, organizationAllowList),
		[models, provider, organizationAllowList],
	)

	const modelIds = React.useMemo(() => {
		if (!filteredModelRecord) return []
		return Object.entries(filteredModelRecord)
			.filter(([id, info]) => {
				if (id === selectedModelId) return true
				// The host cannot set awsCustomArn, so picking this here would save a model id without an ARN.
				if (id === BEDROCK_CUSTOM_ARN_MODEL_ID) return false
				return !info.deprecated
			})
			.map(([id]) => id)
			.sort((a, b) => a.localeCompare(b))
	}, [filteredModelRecord, selectedModelId])

	const searchableItems = React.useMemo(
		() =>
			modelIds.map((id) => ({
				id,
				searchStr: [id, filteredModelRecord?.[id]?.displayName].filter(Boolean).join(" "),
			})),
		[modelIds, filteredModelRecord],
	)

	const fzfInstance = React.useMemo(
		() => new Fzf(searchableItems, { selector: (item) => item.searchStr }),
		[searchableItems],
	)

	const filteredModelIds = React.useMemo(() => {
		if (!searchValue) return modelIds
		return fzfInstance.find(searchValue).map((result) => result.item.id)
	}, [modelIds, searchValue, fzfInstance])

	const triggerLabel = selectedModelInfo?.displayName ?? selectedModelId ?? ""

	const openSettings = React.useCallback(() => {
		vscode.postMessage({ type: "switchTab", tab: "settings" })
		setOpen(false)
	}, [])

	// The host merges this patch into the latest stored profile, so a stale
	// snapshot cannot overwrite newer settings. `null` clears a key.
	const handleModelChange = React.useCallback(
		(modelIdField: string, modelId: string) => {
			if (!provider) return

			const patch: Record<string, unknown> = { [modelIdField]: modelId }

			handleModelChangeSideEffects(provider, modelId, (f, v) => {
				// The host accepts only `null` to clear a key, but the shared helper clears Bedrock fields with "".
				patch[f] = v === undefined || v === "" ? null : v
			})

			vscode.postMessage({
				type: "updateProfileModel",
				text: currentApiConfigName,
				values: { expectedProvider: provider, patch },
			})
		},
		[currentApiConfigName, provider],
	)

	const handleSelect = React.useCallback(
		(modelId: string) => {
			if (!field) return
			if (modelId !== selectedModelId) handleModelChange(field, modelId)
			setOpen(false)
			setSearchValue("")
		},
		[field, handleModelChange, selectedModelId],
	)

	const onClearSearch = React.useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	const onOpenChange = React.useCallback((isOpen: boolean) => {
		setOpen(isOpen)
		if (!isOpen) setSearchValue("")
	}, [])

	React.useEffect(() => {
		if (open && searchInputRef.current) {
			searchInputRef.current.focus()
		}
	}, [open])

	const triggerClasses = cn(
		"inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
		selectorTriggerClassName,
		disabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
		triggerClassName,
	)

	if (isUnsupported) {
		return (
			<StandardTooltip content={t("chat:modelSelector.unsupportedTooltip")}>
				<button
					type="button"
					disabled={disabled}
					data-testid="model-selector-unsupported-trigger"
					onClick={openSettings}
					className={triggerClasses}>
					<span className="truncate">{triggerLabel}</span>
				</button>
			</StandardTooltip>
		)
	}

	const showSearch = modelIds.length > SEARCH_THRESHOLD

	return (
		<Popover open={open} onOpenChange={onOpenChange} data-testid="model-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger disabled={disabled} data-testid="model-selector-trigger" className={triggerClasses}>
					<span className="truncate">{triggerLabel}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden min-w-80 max-w-9/10">
				<div className="flex flex-col w-full">
					{showSearch ? (
						<div className="relative p-2 border-b border-vscode-dropdown-border">
							<input
								aria-label={t("common:ui.search_placeholder")}
								ref={searchInputRef}
								value={searchValue}
								onChange={(e) => setSearchValue(e.target.value)}
								placeholder={t("chat:modelSelector.searchPlaceholder")}
								className="w-full h-8 px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-0"
								data-testid="model-search-input"
							/>
							{searchValue.length > 0 && (
								<div className="absolute right-4 top-0 bottom-0 flex items-center justify-center">
									<X
										className="text-vscode-input-foreground opacity-50 hover:opacity-100 size-4 p-0.5 cursor-pointer"
										onClick={onClearSearch}
									/>
								</div>
							)}
						</div>
					) : (
						<div className="p-3 border-b border-vscode-dropdown-border">
							<p className="m-0 text-xs text-vscode-descriptionForeground">
								{t("chat:modelSelector.description")}
							</p>
						</div>
					)}

					<div className="max-h-[300px] overflow-y-auto">
						{isLoading ? (
							<div className="py-2 px-3 text-sm text-vscode-foreground/70" role="status">
								{t("chat:modelSelector.loading")}
							</div>
						) : filteredModelIds.length === 0 ? (
							<div className="py-2 px-3 text-sm text-vscode-foreground/70">
								{t("common:ui.no_results")}
							</div>
						) : (
							<div className="py-1">
								{filteredModelIds.map((modelId) => {
									const isSelected = modelId === selectedModelId
									const modelInfo = filteredModelRecord?.[modelId]
									return (
										<button
											type="button"
											key={modelId}
											onClick={() => handleSelect(modelId)}
											aria-current={isSelected ? "true" : undefined}
											className={cn(
												"w-full px-3 py-1.5 text-sm text-left cursor-pointer flex items-center",
												"bg-transparent border-0 text-vscode-foreground",
												"focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder",
												"hover:bg-vscode-list-hoverBackground",
												isSelected
													? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
													: "",
											)}
											data-testid="model-selector-item">
											<div className="flex-1 min-w-0">
												<div className="truncate">{modelInfo?.displayName ?? modelId}</div>
											</div>
											{isSelected && <Check className="ml-auto size-4 p-0.5" />}
										</button>
									)
								})}
							</div>
						)}
					</div>

					<div className="flex flex-row items-center justify-between px-2 py-2 border-t border-vscode-dropdown-border">
						<div className="flex flex-row gap-1">
							<IconButton
								iconClass="codicon-settings-gear"
								title={t("chat:modelSelector.settings")}
								onClick={openSettings}
							/>
						</div>
						<div className="flex items-center gap-1 pr-1">
							{showSearch && (
								<StandardTooltip content={t("chat:modelSelector.description")}>
									<span className="codicon codicon-info text-xs text-vscode-descriptionForeground opacity-70 hover:opacity-100 cursor-help" />
								</StandardTooltip>
							)}
							<h4 className="m-0 font-medium text-sm text-vscode-descriptionForeground">
								{t("chat:modelSelector.title")}
							</h4>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
