import { useCallback, useMemo } from "react"

import type { ProviderName } from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelPicker } from "@/components/settings/ModelPicker"

import { useChatModelSelector } from "./hooks/useChatModelSelector"

interface ChatModelSelectorProps {
	disabled?: boolean
	title: string
	triggerClassName?: string
}

/**
 * Compact model picker for the chat input bar.
 *
 * It reuses the settings page {@link ModelPicker} in `compact` mode (search,
 * filtering, custom-model escape hatch and org-policy filtering all live there)
 * and adds a chat-specific trigger plus a persistence adapter: the settings
 * picker writes to the local settings buffer via `setApiConfigurationField`,
 * while the chat bar persists the selection to the active API configuration
 * profile via `upsertApiConfiguration`.
 */
export const ChatModelSelector = ({ disabled = false, title, triggerClassName = "" }: ChatModelSelectorProps) => {
	const { apiConfiguration, organizationAllowList, currentApiConfigName } = useExtensionState()
	const { provider, models, modelIdKey, defaultModelId, isLoading, valueTransform, displayTransform } =
		useChatModelSelector()

	const portalContainer = useRooPortal("roo-portal")

	// Persist the selection to the active profile. The picker applies
	// `valueTransform` before calling back, so the adapter stores the received
	// value directly under the provider's model field.
	const persistModel = useCallback(
		(value: unknown) => {
			if (!modelIdKey || !apiConfiguration || !currentApiConfigName) {
				return
			}

			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration: { ...apiConfiguration, apiProvider: provider, [modelIdKey]: value },
			})
		},
		[provider, modelIdKey, apiConfiguration, currentApiConfigName],
	)

	const setApiConfigurationField = useCallback(
		<K extends keyof typeof apiConfiguration>(_field: K, value: (typeof apiConfiguration)[K]) => {
			persistModel(value)
		},
		[persistModel],
	)

	// Free-form model ids are only offered when the provider is unrestricted.
	const hideCustomModel = useMemo(() => {
		if (!organizationAllowList || organizationAllowList.allowAll) return false
		const providerConfig = provider ? organizationAllowList.providers?.[provider] : undefined
		return !providerConfig?.allowAll
	}, [organizationAllowList, provider])

	const isDisabled = disabled || !modelIdKey || !currentApiConfigName

	return (
		<ModelPicker
			compact
			apiConfiguration={apiConfiguration ?? {}}
			setApiConfigurationField={setApiConfigurationField}
			models={models}
			modelIdKey={modelIdKey ?? "apiModelId"}
			defaultModelId={defaultModelId}
			serviceName=""
			serviceUrl=""
			organizationAllowList={organizationAllowList}
			activeProviderOverride={provider as ProviderName | undefined}
			valueTransform={valueTransform}
			displayTransform={displayTransform}
			tooltip={title}
			disabled={isDisabled}
			isLoading={isLoading}
			hideCustomModel={hideCustomModel}
			contentClassName="overflow-hidden"
			portalContainer={portalContainer}
			renderTrigger={({ displayValue, isLoading: loading, placeholder }) => (
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
						{loading ? "…" : displayValue || defaultModelId || placeholder}
					</span>
				</button>
			)}
		/>
	)
}
