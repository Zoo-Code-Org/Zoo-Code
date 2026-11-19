import { useCallback, useEffect, useMemo, useState } from "react"

import { openAiModelInfoSaneDefaults, type ModelRecord } from "@roo-code/types"

import { discoverOpenAiModels, type OpenAiDiscoverySettings } from "./openAiModelDiscovery"

type DiscoveryState = {
	identity: OpenAiDiscoverySettings
	models: ModelRecord | null
}

export function useOpenAiModelCatalog(settings: OpenAiDiscoverySettings, enabled: boolean) {
	const { openAiBaseUrl, openAiApiKey, openAiHeaders } = settings
	// Content identity stays local; credentials must never become query keys.
	const headers = JSON.stringify(Object.entries(openAiHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)))
	const [attempt, setAttempt] = useState(0)
	const identity = useMemo(
		() => ({
			openAiBaseUrl,
			openAiApiKey,
			openAiHeaders: Object.fromEntries(JSON.parse(headers) as [string, string][]),
			enabled,
			attempt,
		}),
		[openAiBaseUrl, openAiApiKey, headers, enabled, attempt],
	)
	const [state, setState] = useState<DiscoveryState>()
	const refetch = useCallback(() => setAttempt((value) => value + 1), [])
	// Discovery, unlike inference, has no default base URL or API key. Missing values
	// stay settings-only, matching the host's explicit base URL + API key requirement.
	const canDiscover = enabled && !!openAiBaseUrl && !!openAiApiKey

	useEffect(() => {
		if (!canDiscover) return
		const controller = new AbortController()
		void discoverOpenAiModels(identity, controller.signal).then(
			(ids) => {
				if (controller.signal.aborted) return
				setState({
					identity,
					models: Object.fromEntries(ids.map((id) => [id, { ...openAiModelInfoSaneDefaults }])),
				})
			},
			() => {
				if (!controller.signal.aborted) setState({ identity, models: null })
			},
		)
		return () => controller.abort()
	}, [identity, canDiscover])

	// Hide the previous profile's result synchronously, before effect cleanup runs.
	const current = canDiscover && state?.identity === identity ? state : undefined
	return {
		models: current?.models ?? null,
		isLoading: canDiscover && !current,
		isError: (enabled && !canDiscover) || current?.models === null,
		refetch,
	}
}
