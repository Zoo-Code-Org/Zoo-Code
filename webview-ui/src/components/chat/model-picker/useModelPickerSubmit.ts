import { useCallback } from "react"
import type { ProviderName } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import type { ProfileModelPatch } from "./profileModelPatches"

export function useModelPickerSubmit(
	profileName: string | undefined,
	provider: ProviderName | undefined,
	disabled: boolean,
) {
	return useCallback(
		(patch: ProfileModelPatch) => {
			if (disabled || !profileName || !provider) return
			vscode.postMessage({
				type: "updateProfileModel",
				text: profileName,
				values: { expectedProvider: provider, patch },
			})
		},
		[profileName, provider, disabled],
	)
}
