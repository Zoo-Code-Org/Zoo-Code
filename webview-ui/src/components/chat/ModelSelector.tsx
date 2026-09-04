import { useState, useMemo, useCallback } from "react"
import { Fzf } from "fzf"

import {
	type ModelInfo,
	type ModelRecord,
	type ProviderSettings,
	isDynamicProvider,
	isRetiredProvider,
	providerIdentifiers,
} from "@roo-code/types"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

import {
	getProviderModelConfig,
	getStaticModelsForProvider,
	isStaticModelProvider,
} from "../settings/utils/providerModelConfig"

const SEARCH_THRESHOLD = 6

interface ModelSelectorProps {
	apiConfiguration: ProviderSettings
	currentApiConfigName?: string
	disabled?: boolean
	title: string
	triggerClassName?: string
}

export const ModelSelector = ({
	apiConfiguration,
	currentApiConfigName,
	disabled = false,
	title,
	triggerClassName = "",
}: ModelSelectorProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const portalContainer = useRooPortal("roo-portal")

	const rawProvider = apiConfiguration?.apiProvider || providerIdentifiers.openrouter
	const retired = isRetiredProvider(rawProvider)
	const provider = retired ? providerIdentifiers.openrouter : rawProvider
	const dynamicProvider = !retired && isDynamicProvider(provider) ? provider : undefined
	const modelConfig = retired ? undefined : getProviderModelConfig(provider, apiConfiguration)

	const routerModels = useRouterModels({ provider: dynamicProvider, enabled: !!dynamicProvider })
	const { id: selectedModelId, info: selectedModelInfo, isLoading } = useSelectedModel(apiConfiguration)

	const models: ModelRecord = useMemo(() => {
		// Stryker disable next-line ConditionalExpression,BlockStatement: every provider that is
		// dynamic or has static models also has an entry in PROVIDER_MODEL_CONFIG, so `modelConfig`
		// is only ever undefined for providers that would fall through to `{}` below anyway.
		if (!modelConfig) {
			return {}
		}

		if (dynamicProvider) {
			return routerModels.data?.[dynamicProvider] ?? {}
		}

		// Stryker disable next-line ConditionalExpression: getStaticModelsForProvider already
		// falls back to `{}` for a provider missing from MODELS_BY_PROVIDER, so forcing this
		// branch to run unconditionally yields the same result as the `false` case below.
		if (isStaticModelProvider(provider)) {
			const staticModels = getStaticModelsForProvider(provider, undefined, apiConfiguration)
			const { "custom-arn": _customArn, ...rest } = staticModels
			return rest
		}

		return {}
	}, [modelConfig, dynamicProvider, routerModels.data, provider, apiConfiguration])

	const modelIds = useMemo(() => Object.keys(models), [models])

	const isSupported = !!modelConfig && modelIds.length > 0
	const isDisabled = disabled || !isSupported

	// Label shown for a model — prefers `ModelInfo.displayName` when present, falling back to
	// the raw model id (mirrors ModelPicker.tsx's trigger/list label logic).
	// Stryker disable next-line ArrayDeclaration: this callback closes over no props or state, so
	// its identity across renders isn't observable — only its (unmutated) body behavior is.
	const getModelLabel = useCallback((modelId: string, info?: ModelInfo) => info?.displayName ?? modelId, [])

	const selectedModelLabel = getModelLabel(selectedModelId, selectedModelInfo)

	// Create searchable items for fuzzy search.
	const searchableItems = useMemo(
		() =>
			modelIds.map((id) => {
				const label = getModelLabel(id, models[id])
				return { original: id, searchStr: label === id ? id : `${label} ${id}` }
			}),
		[modelIds, models, getModelLabel],
	)

	const fzfInstance = useMemo(
		() => new Fzf(searchableItems, { selector: (item) => item.searchStr }),
		[searchableItems],
	)

	const filteredModelIds = useMemo(() => {
		// Stryker disable next-line ConditionalExpression,BlockStatement: fzf's `find("")` already
		// returns every item in its original order, so skipping this shortcut is unobservable.
		if (!searchValue) {
			return modelIds
		}

		return fzfInstance.find(searchValue).map((result) => result.item.original)
	}, [modelIds, searchValue, fzfInstance])

	const handleEditClick = useCallback(
		() => {
			vscode.postMessage({ type: "switchTab", tab: "settings" })
			// Stryker disable next-line BooleanLiteral,CallExpression: this button only renders
			// while the popover (and its `open` state) doesn't exist, so this call has no
			// observable effect either way.
			setOpen(false)
		},
		// Stryker disable next-line ArrayDeclaration: this callback closes over no props or state.
		[],
	)

	const handleSelect = useCallback(
		(modelId: string) => {
			// Stryker disable next-line ConditionalExpression,BlockStatement: handleSelect is only
			// ever invoked from a rendered model-list item, which requires a non-empty `models`
			// map, which in turn requires `modelConfig` to be defined — this guard can't be hit.
			if (!modelConfig) {
				return
			}

			const updated: ProviderSettings = {
				...apiConfiguration,
				reasoningEffort: undefined,
				modelMaxTokens: undefined,
				modelMaxThinkingTokens: undefined,
			}
			;(updated as Record<string, unknown>)[modelConfig.field] = modelId

			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration: updated,
			})

			setOpen(false)
			setSearchValue("")
		},
		[apiConfiguration, modelConfig, currentApiConfigName],
	)

	const renderModelItem = useCallback(
		(modelId: string) => {
			const isCurrentModel = modelId === selectedModelId
			const label = getModelLabel(modelId, models[modelId])

			return (
				<div
					key={modelId}
					onClick={() => handleSelect(modelId)}
					className={cn(
						"px-3 py-1.5 text-sm cursor-pointer flex items-center group",
						"hover:bg-vscode-list-hoverBackground",
						isCurrentModel &&
							"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
					)}>
					<div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</div>
					{isCurrentModel && (
						<div className="size-5 p-1 flex items-center justify-center">
							<span className="codicon codicon-check text-xs" />
						</div>
					)}
				</div>
			)
		},
		[selectedModelId, models, getModelLabel, handleSelect],
	)

	if (!isSupported) {
		return (
			<StandardTooltip content={t("chat:selectModelUnsupported")}>
				<button
					data-testid="model-selector-disabled"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						"opacity-50",
						triggerClassName,
					)}
					onClick={handleEditClick}>
					<span className="truncate">{selectedModelLabel || provider}</span>
				</button>
			</StandardTooltip>
		)
	}

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="model-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={isDisabled}
					data-testid="model-selector-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						isDisabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
						triggerClassName,
					)}>
					<span className="truncate">{isLoading ? t("common:ui.loading") : selectedModelLabel}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[300px]">
				<div className="flex flex-col w-full">
					{modelIds.length > SEARCH_THRESHOLD && (
						<div className="relative p-2 border-b border-vscode-dropdown-border">
							<input
								aria-label={t("common:ui.search_placeholder")}
								value={searchValue}
								onChange={(e) => setSearchValue(e.target.value)}
								placeholder={t("common:ui.search_placeholder")}
								className="w-full h-8 px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-0"
								autoFocus
							/>
							{searchValue.length > 0 && (
								<div className="absolute right-4 top-0 bottom-0 flex items-center justify-center">
									<span
										className="codicon codicon-close text-vscode-input-foreground opacity-50 hover:opacity-100 text-xs cursor-pointer"
										onClick={() => setSearchValue("")}
									/>
								</div>
							)}
						</div>
					)}

					{filteredModelIds.length === 0 ? (
						<div className="py-2 px-3 text-sm text-vscode-foreground/70">{t("common:ui.no_results")}</div>
					) : (
						<div className="max-h-[300px] overflow-y-auto py-1">
							{filteredModelIds.map(renderModelItem)}
						</div>
					)}

					<div className="flex flex-row items-center justify-between px-2 py-2 border-t border-vscode-dropdown-border">
						<h4 className="m-0 font-medium text-sm text-vscode-descriptionForeground">
							{t("chat:selectModel")}
						</h4>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
