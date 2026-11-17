import React from "react"
import { Fzf } from "fzf"
import { Check } from "lucide-react"
import { type ProviderSettings, providerIdentifiers } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { filterModels } from "@/components/settings/utils/organizationFilters"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { PickerSearchField } from "./PickerSearchField"
import type { ProfileModelCatalog } from "./model-picker/useProfileModelCatalog"
import { pickerResultsClassName, handlePickerNavigation } from "./model-picker/pickerNavigation"

const BEDROCK_CUSTOM_ARN_MODEL_ID = "custom-arn"

interface ModelSelectorProps {
	apiConfiguration: ProviderSettings
	disabled?: boolean
	onSelect: (id: string) => void
	catalog: ProfileModelCatalog
}

/** Embedded catalog panel; the parent owns the popover and profile saves. */
export const ModelSelector = ({
	apiConfiguration,
	disabled = false,
	onSelect: handleSelect,
	catalog,
}: ModelSelectorProps) => {
	const [searchValue, setSearchValue] = React.useState("")
	const { t } = useAppTranslation()
	const { organizationAllowList } = useExtensionState()
	const { id: selectedModelId } = useSelectedModel(apiConfiguration)
	const { provider, models, isLoading, isError, isUnsupported, refetch } = catalog
	const filteredModelRecord = React.useMemo(
		() => filterModels(models, provider, organizationAllowList),
		[models, provider, organizationAllowList],
	)

	const modelIds = React.useMemo(() => {
		if (!filteredModelRecord) return []
		return Object.entries(filteredModelRecord)
			.filter(([id, info]) => {
				if (
					provider === providerIdentifiers.bedrock &&
					(id.startsWith("arn:") || (id === BEDROCK_CUSTOM_ARN_MODEL_ID && !apiConfiguration.awsCustomArn))
				)
					return false
				if (id === selectedModelId) return true
				return !info.deprecated
			})
			.map(([id]) => id)
			.sort((a, b) => a.localeCompare(b))
	}, [filteredModelRecord, selectedModelId, provider, apiConfiguration.awsCustomArn])

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

	return (
		<div className="flex min-h-0 flex-col" onKeyDown={handlePickerNavigation}>
			<PickerSearchField
				label={t("chat:modelPicker.searchModels")}
				value={searchValue}
				onChange={setSearchValue}
				disabled={disabled || isUnsupported}
			/>
			<div
				role="group"
				aria-label={t("chat:modelPicker.providerModels")}
				aria-busy={isLoading}
				className={cn(pickerResultsClassName, "py-1")}>
				{isLoading ? (
					<div role="status" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
						{t("chat:modelSelector.loading")}
					</div>
				) : isError ? (
					<div role="alert" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
						{t("chat:error")}
						<button
							type="button"
							onClick={refetch}
							disabled={disabled}
							className="ml-2 cursor-pointer rounded border border-vscode-input-border bg-transparent px-2 py-1 text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
							{t("chat:retry.title")}
						</button>
					</div>
				) : isUnsupported ? (
					<div className="px-3 py-2 text-xs text-vscode-descriptionForeground">
						{t("chat:modelPicker.modelSettingsHint")}
					</div>
				) : filteredModelIds.length === 0 ? (
					<div role="status" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
						{t("common:ui.no_results")}
					</div>
				) : (
					<div>
						{filteredModelIds.map((modelId) => {
							const isSelected = modelId === selectedModelId
							const modelInfo = filteredModelRecord?.[modelId]
							return (
								<button
									type="button"
									disabled={disabled}
									key={modelId}
									onClick={() => handleSelect(modelId)}
									aria-current={isSelected ? "true" : undefined}
									className={cn(
										"flex w-full cursor-pointer items-center gap-2 border-none px-3 py-1.5 text-left text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder disabled:opacity-50",
										isSelected
											? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
											: "bg-transparent",
									)}
									data-picker-result
									aria-pressed={isSelected}
									data-testid="model-selector-item">
									<span className="min-w-0 flex-1 truncate" title={modelId}>
										{modelInfo?.displayName ?? modelId}
									</span>
									{isSelected && <Check aria-hidden="true" className="size-3 shrink-0" />}
								</button>
							)
						})}
					</div>
				)}
				{!isLoading && (isUnsupported || isError || filteredModelIds.length === 0) && (
					<button
						type="button"
						onClick={() => vscode.postMessage({ type: "switchTab", tab: "settings" })}
						className="mx-3 my-2 cursor-pointer rounded border border-vscode-input-border bg-transparent px-2 py-1 text-xs text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
						{t("chat:modelSelector.settings")}
					</button>
				)}
			</div>
		</div>
	)
}
