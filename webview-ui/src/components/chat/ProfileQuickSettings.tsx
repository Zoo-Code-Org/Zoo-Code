import { useState } from "react"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { filterModels } from "@/components/settings/utils/organizationFilters"
import { PickerSearchField } from "./PickerSearchField"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { createModelPatch, createReasoningPatch, getReasoningSelection, useProfileModelCatalog } from "./model-picker"
import { ModelResults } from "./model-picker/ModelResults"
import { ReasoningControls } from "./model-picker/ReasoningControls"
import { useModelPickerSubmit } from "./model-picker/useModelPickerSubmit"
import { handlePickerNavigation } from "./model-picker/pickerNavigation"

/** Immediate, partial saves only; the host owns merging and publishing the resulting profile. */
export function ProfileQuickSettings({ disabled = false }: { disabled?: boolean }) {
	const { t } = useAppTranslation()
	const { apiConfiguration, currentApiConfigName, organizationAllowList } = useExtensionState()
	const { id: modelId, info } = useSelectedModel(apiConfiguration)
	const catalog = useProfileModelCatalog(apiConfiguration)
	const reasoning = getReasoningSelection(apiConfiguration, info)
	const [search, setSearch] = useState("")
	const submit = useModelPickerSubmit(currentApiConfigName, catalog.provider, disabled)
	const models = filterModels(catalog.models, catalog.provider, organizationAllowList)
	const canSelect = !disabled && !!currentApiConfigName && !!catalog.field && !catalog.isLoading && !catalog.isError

	return (
		<div className="flex min-h-0 flex-col" onKeyDown={handlePickerNavigation}>
			<PickerSearchField
				label={t("chat:modelPicker.searchModels")}
				value={search}
				onChange={setSearch}
				disabled={disabled || catalog.isUnsupported}
			/>
			<ModelResults
				models={models}
				selectedId={modelId}
				search={search}
				allowCustomArn={!!apiConfiguration.awsCustomArn}
				provider={catalog.provider}
				isLoading={catalog.isLoading}
				isError={catalog.isError}
				settingsOnly={catalog.isUnsupported || !!catalog.fallbackMessage}
				disabled={disabled || !currentApiConfigName}
				onRetry={catalog.refetch}
				onSettings={() => vscode.postMessage({ type: "switchTab", tab: "settings" })}
				onSelect={(id) => {
					if (canSelect && id !== modelId) submit(createModelPatch(apiConfiguration, id))
				}}
			/>
			<ReasoningControls
				selection={reasoning}
				disabled={disabled || !currentApiConfigName || !catalog.provider}
				onSelect={(effort) => submit(createReasoningPatch(apiConfiguration, effort, info))}
			/>
		</div>
	)
}
