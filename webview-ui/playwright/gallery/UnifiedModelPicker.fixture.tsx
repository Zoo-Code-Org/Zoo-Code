import { useState } from "react"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { ApiConfigSelector } from "@/components/chat/ApiConfigSelector"
import { ProfileQuickSettings } from "@/components/chat/ProfileQuickSettings"

import { AppProviders } from "../AppProviders"
import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const profiles = [
	{ id: "work", name: "Work", modelId: "gpt-5" },
	{ id: "personal", name: "Personal", modelId: "gpt-5-mini" },
	{ id: "review", name: "Review", modelId: "gpt-5.4" },
]

/** Real picker, static production catalog, and fresh browser-owned state on every mount. */
export function UnifiedModelPickerStory() {
	return (
		<AppProviders
			initialState={{
				apiConfiguration: {
					apiProvider: providerIdentifiers.openaiNative,
					apiModelId: profiles[0].modelId,
					reasoningEffort: "high",
					enableReasoningEffort: true,
				},
				currentApiConfigName: profiles[0].name,
				listApiConfigMeta: profiles,
				pinnedApiConfigs: { work: true },
				lockApiConfigAcrossModes: false,
			}}>
			<MountedModelPicker />
		</AppProviders>
	)
}

function MountedModelPicker() {
	const state = useExtensionState()
	const [profileId, setProfileId] = useState("work")
	const [pinned, setPinned] = useState<Record<string, boolean>>({ work: true })
	const [locked, setLocked] = useState(false)
	const profile = profiles.find(({ id }) => id === profileId) ?? profiles[0]
	const apiConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.openaiNative,
		apiModelId: profile.modelId,
		reasoningEffort: "high",
		enableReasoningEffort: true,
	}

	return (
		<ExtensionStateContextProvider
			initialState={{ ...state, apiConfiguration, currentApiConfigName: profile.name }}>
			<div className="flex h-screen w-full flex-col justify-end bg-vscode-editor-background p-3">
				<ApiConfigSelector
					value={profile.id}
					displayName={profile.name}
					modelId={profile.modelId}
					reasoningEffort="high"
					quickSettings={<ProfileQuickSettings />}
					title="Choose profile and model"
					triggerClassName="max-w-full self-start"
					onChange={(id) => {
						const next = profiles.find((candidate) => candidate.id === id) ?? profiles[0]
						// The gallery provider accepts live values; keep the picker mounted while switching context.
						setProfileId(next.id)
					}}
					listApiConfigMeta={profiles}
					pinnedApiConfigs={pinned}
					togglePinnedApiConfig={(id) => setPinned((previous) => ({ ...previous, [id]: !previous[id] }))}
					lockApiConfigAcrossModes={locked}
					onToggleLockApiConfig={() => setLocked((previous) => !previous)}
				/>
			</div>
		</ExtensionStateContextProvider>
	)
}
