import { useCallback, useEffect, useMemo, useState } from "react"

import { openAiModelInfoSaneDefaults, type ModelRecord } from "@roo-code/types"

import { discoverOpenAiModels, type OpenAiDiscoverySettings } from "./openAiModelDiscovery"

type DiscoveryState = {
	identity: OpenAiDiscoverySettings
	attempt: number
	models: ModelRecord | null
	isError: boolean
}

export function useOpenAiModelCatalog(settings: OpenAiDiscoverySettings, enabled: boolean) {
	const { openAiBaseUrl, openAiApiKey, openAiHeaders } = settings
	const identity = useMemo(
		() => ({ openAiBaseUrl, openAiApiKey, openAiHeaders, enabled }),
		[openAiBaseUrl, openAiApiKey, openAiHeaders, enabled],
	)
	const [attempt, setAttempt] = useState(0)
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
					attempt,
					models: Object.fromEntries(ids.map((id) => [id, { ...openAiModelInfoSaneDefaults }])),
					isError: false,
				})
			},
			() => {
				if (!controller.signal.aborted) setState({ identity, attempt, models: null, isError: true })
			},
		)
		return () => controller.abort()
	}, [identity, attempt, canDiscover])

	// Hide the previous profile's result synchronously, before effect cleanup runs.
	const current = canDiscover && state?.identity === identity && state.attempt === attempt ? state : undefined
	return {
		models: current?.models ?? null,
		isLoading: canDiscover && !current,
		isError: (enabled && !canDiscover) || (current?.isError ?? false),
		refetch,
	}
}
