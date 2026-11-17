import { replaceEqualDeep, useQuery } from "@tanstack/react-query"
import equal from "fast-deep-equal"
import { useRef } from "react"

import {
	allRouterModelsProvider,
	RouterModelsMessageType,
	type RouterModels,
	type ExtensionMessage,
	type ProviderSettings,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

type UseRouterModelsOptions = {
	provider?: string // single provider filter (e.g. "openrouter")
	enabled?: boolean // gate fetching entirely
	/** Isolated, request-owned discovery. Omitted by legacy aggregate consumers. */
	apiConfiguration?: ProviderSettings
}

export const fetchRouterModels = async (provider?: string, signal?: AbortSignal, apiConfiguration?: ProviderSettings) =>
	new Promise<RouterModels>((resolve, reject) => {
		const requestId = apiConfiguration ? crypto.randomUUID() : undefined
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort)
			window.removeEventListener("message", handler)
		}

		const onAbort = () => {
			clearTimeout(timeout)
			cleanup()
			reject(new DOMException("Router models request aborted", "AbortError"))
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Router models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === RouterModelsMessageType.routerModels) {
				const msgProvider = message?.values?.provider as string | undefined

				// Verify response matches request
				if (provider !== msgProvider || message.requestId !== requestId) {
					// Not our response; ignore and wait for the matching one
					return
				}

				clearTimeout(timeout)
				cleanup()

				if (message.routerModels) {
					resolve(message.routerModels)
				} else {
					reject(new Error("No router models in response"))
				}
			}
		}

		if (signal?.aborted) {
			onAbort()
			return
		}

		signal?.addEventListener("abort", onAbort, { once: true })
		window.addEventListener("message", handler)
		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			...(provider && { values: { provider } }),
			...(apiConfiguration && { requestId, apiConfiguration }),
		})
	})

export const useRouterModels = (opts: UseRouterModelsOptions = {}) => {
	const provider = opts.provider || undefined
	const scope = useRef<{ config: ProviderSettings; cacheScope: string }>()
	if (opts.apiConfiguration && !equal(scope.current?.config, opts.apiConfiguration)) {
		scope.current = { config: opts.apiConfiguration, cacheScope: crypto.randomUUID() }
	}
	const owned = opts.apiConfiguration ? scope.current : undefined
	return useQuery({
		queryKey: [
			RouterModelsMessageType.routerModels,
			provider || allRouterModelsProvider,
			...(owned ? [owned.cacheScope] : []),
		],
		queryFn: ({ signal }) => fetchRouterModels(provider, signal, owned?.config),
		enabled: opts.enabled !== false,
		// Structural sharing copies into `{}`, where an own "__proto__" model ID would swap the
		// copy's prototype instead of becoming a key, so skip sharing for such catalogs.
		structuralSharing: (oldData, newData) =>
			hasOwnProtoModelId(newData) ? newData : replaceEqualDeep(oldData, newData),
	})
}

const hasOwnProtoModelId = (data: unknown): boolean =>
	typeof data === "object" &&
	data !== null &&
	Object.values(data).some(
		(models) => typeof models === "object" && models !== null && Object.hasOwn(models, "__proto__"),
	)
