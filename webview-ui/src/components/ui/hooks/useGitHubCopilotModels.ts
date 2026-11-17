import { useEffect } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"

import { type ExtensionMessage, VsCodeLmModelsMessageType } from "@roo-code/types"

export type GitHubCopilotModels = NonNullable<ExtensionMessage["vsCodeLmModels"]>

const GITHUB_COPILOT_MODELS_QUERY_KEY = ["githubCopilotModels"] as const

/**
 * The Copilot models VS Code currently offers, with the capabilities VS Code reports for each.
 *
 * The extension is the source of truth and pushes this list: when the view opens, after sign-in,
 * on a manual refresh, and whenever the host registers or removes models. The hook only holds the
 * latest push in the shared query cache, so the model picker and model selection read one list, and
 * nothing about a model is ever copied into saved settings where it could go stale.
 *
 * A message that carries an error, or no list at all (the account-only update sent mid sign-in),
 * leaves the last known list in place rather than reading as "no models".
 */
export const useGitHubCopilotModels = (enabled: boolean) => {
	const queryClient = useQueryClient()

	useEffect(() => {
		if (!enabled) return

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			const carriesModels =
				message.type === VsCodeLmModelsMessageType.githubCopilotModels ||
				message.type === VsCodeLmModelsMessageType.githubCopilotSignInResult
			if (carriesModels && !message.error && message.vsCodeLmModels) {
				queryClient.setQueryData<GitHubCopilotModels>(GITHUB_COPILOT_MODELS_QUERY_KEY, message.vsCodeLmModels)
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [enabled, queryClient])

	// `skipToken`: this query never fetches; its data only ever arrives from the extension.
	return useQuery<GitHubCopilotModels>({ queryKey: GITHUB_COPILOT_MODELS_QUERY_KEY, queryFn: skipToken })
}
