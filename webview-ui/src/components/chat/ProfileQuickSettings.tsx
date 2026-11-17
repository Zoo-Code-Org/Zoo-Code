import { useState } from "react"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { createModelPatch, createReasoningPatch, getReasoningSelection, useProfileModelCatalog } from "./model-picker"
import { ModelSelector } from "./ModelSelector"
import { ReasoningControls } from "./model-picker/ReasoningControls"
import { useModelPickerSubmit } from "./model-picker/useModelPickerSubmit"

/** Immediate, partial saves only; the host owns merging and publishing the resulting profile. */
export function ProfileQuickSettings({ disabled = false }: { disabled?: boolean }) {
	const { apiConfiguration, currentApiConfigName } = useExtensionState()
	const { id: modelId, info, isLoading: isSelectionLoading } = useSelectedModel(apiConfiguration)
	const catalog = useProfileModelCatalog(apiConfiguration)
	const reasoning = getReasoningSelection(apiConfiguration, info)
	const [pendingModelId, setPendingModelId] = useState<string | null>(null)
	const pending = pendingModelId !== null && pendingModelId !== modelId
	if (pendingModelId === modelId) setPendingModelId(null)
	const submit = useModelPickerSubmit(
		currentApiConfigName,
		catalog.provider,
		disabled || pending || !!isSelectionLoading,
	)
	const canSelect = !disabled && !!currentApiConfigName && !!catalog.field && !catalog.isLoading && !catalog.isError

	return (
		<div className="flex min-h-0 flex-col">
			<ModelSelector
				apiConfiguration={apiConfiguration}
				catalog={catalog}
				disabled={disabled || pending || !!isSelectionLoading || !currentApiConfigName}
				onSelect={(id) => {
					if (canSelect && !pending && id !== modelId) {
						submit(createModelPatch(apiConfiguration, id))
						setPendingModelId(id)
					}
				}}
			/>
			<ReasoningControls
				selection={reasoning}
				disabled={disabled || pending || !!isSelectionLoading || !currentApiConfigName || !catalog.provider}
				onSelect={(effort) => submit(createReasoningPatch(apiConfiguration, effort, info))}
			/>
		</div>
	)
}
