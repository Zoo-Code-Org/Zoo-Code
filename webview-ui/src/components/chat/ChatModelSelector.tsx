import { useCallback, useMemo } from "react"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelSelect } from "@/components/ui/model-select/ModelSelect"

import { useChatModelSelector } from "./hooks/useChatModelSelector"

interface ChatModelSelectorProps {
	disabled?: boolean
	title: string
	triggerClassName?: string
}

/**
 * Compact model picker for the chat input bar.
 *
 * Wraps the shared {@link ModelSelect} with a chat-specific trigger and a
 * persistence adapter: selections are written to the active API configuration
 * profile via `upsertApiConfiguration` rather than the settings buffer.
 */
export const ChatModelSelector = ({ disabled = false, title, triggerClassName = "" }: ChatModelSelectorProps) => {
	const { apiConfiguration, organizationAllowList, currentApiConfigName } = useExtensionState()
	const { provider, models, modelIdKey, defaultModelId, isLoading, valueTransform, displayTransform } =
		useChatModelSelector()

	const portalContainer = useRooPortal("roo-portal")

	// Compute the display string for the currently stored selection.
	const displayValue = useMemo(() => {
		if (!modelIdKey) return ""
		const stored = apiConfiguration?.[modelIdKey]
		if (!stored) return ""
		return displayTransform ? displayTransform(stored) : String(stored)
	}, [apiConfiguration, modelIdKey, displayTransform])

	// Persist the selection to the active profile. ModelSelect delivers the
	// raw model id, so apply valueTransform before writing.
	const persistSelection = useCallback(
		(modelId: string) => {
			// Refuse to write until the user has actually picked a provider —
			// the profile schema strips provider-specific fields from
			// provider-less profiles, so the selection would be dropped on reload.
			if (!modelIdKey || !apiConfiguration || !currentApiConfigName || !apiConfiguration.apiProvider) {
				return
			}

			const value = valueTransform ? valueTransform(modelId) : modelId
			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration: { ...apiConfiguration, [modelIdKey]: value },
			})
		},
		[modelIdKey, apiConfiguration, currentApiConfigName, valueTransform],
	)

	// Free-form model ids are only offered when the provider is unrestricted.
	const hideCustomModel = useMemo(() => {
		if (!organizationAllowList || organizationAllowList.allowAll) return false
		const providerConfig = provider ? organizationAllowList.providers?.[provider] : undefined
		return !providerConfig?.allowAll
	}, [organizationAllowList, provider])

	const isDisabled = disabled || !modelIdKey || !currentApiConfigName || !apiConfiguration?.apiProvider

	return (
		<ModelSelect
			models={models}
			value={displayValue}
			onChange={persistSelection}
			disabled={isDisabled}
			isLoading={isLoading}
			hideCustomModel={hideCustomModel}
			activeProvider={provider}
			organizationAllowList={organizationAllowList}
			contentClassName="overflow-hidden"
			portalContainer={portalContainer}
			tooltip={title}
			renderTrigger={({ displayValue: value, isLoading: loading, placeholder }) => (
				<button
					type="button"
					disabled={isDisabled}
					data-testid="chat-model-selector-trigger"
					className={cn(
						"min-w-0 inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						isDisabled
							? "opacity-50 cursor-not-allowed"
							: "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						triggerClassName,
					)}>
					<span className="truncate max-w-[20ch]">
						{loading ? "…" : value || defaultModelId || placeholder}
					</span>
				</button>
			)}
		/>
	)
}
