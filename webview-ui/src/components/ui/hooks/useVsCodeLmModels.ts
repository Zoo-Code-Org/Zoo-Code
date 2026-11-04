import { useEffect } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"

import { type ExtensionMessage, providerIdentifiers, VsCodeLmModelsMessageType } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

export type VsCodeLmModels = NonNullable<ExtensionMessage["vsCodeLmModels"]>

const VSCODE_LM_MODELS_QUERY_KEY = ["vsCodeLmModels"] as const

export const useVsCodeLmModels = (enabled: boolean) => {
	const queryClient = useQueryClient()

	useEffect(() => {
		if (!enabled) return

		const handler = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type !== VsCodeLmModelsMessageType.vsCodeLmModels) return
			if (message.error) {
				queryClient.setQueryData<VsCodeLmModels>(VSCODE_LM_MODELS_QUERY_KEY, [])
			} else if (message.vsCodeLmModels) {
				queryClient.setQueryData<VsCodeLmModels>(VSCODE_LM_MODELS_QUERY_KEY, message.vsCodeLmModels)
			}
		}

		window.addEventListener("message", handler)
		vscode.postMessage({
			type: VsCodeLmModelsMessageType.requestVsCodeLmModels,
			apiConfiguration: { apiProvider: providerIdentifiers.vscodeLm },
		})
		return () => window.removeEventListener("message", handler)
	}, [enabled, queryClient])

	return useQuery<VsCodeLmModels>({ queryKey: VSCODE_LM_MODELS_QUERY_KEY, queryFn: skipToken })
}
