import { useQuery } from "@tanstack/react-query"

import {
	allRouterModelsProvider,
	RouterModelsMessageType,
	type RouterModels,
	type ExtensionMessage,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

type UseRouterModelsOptions = {
	provider?: string // single provider filter (e.g. "openrouter")
	enabled?: boolean // gate fetching entirely
}

export const fetchRouterModels = async (provider?: string, signal?: AbortSignal) =>
	new Promise<RouterModels>((resolve, reject) => {
		// Correlate the response by a unique request ID instead of the provider
		// alone: a remount can issue a replacement request for the same provider
		// while a stale response to an aborted request is still in flight, and
		// provider-only matching would let that stale response resolve the new
		// query. The extension host echoes the ID in the routerModels response.
		const requestId = crypto.randomUUID()

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Router models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === RouterModelsMessageType.routerModels) {
				const msgRequestId = message?.values?.requestId as string | undefined

				// Verify the response belongs to this exact request.
				if (msgRequestId !== requestId) {
					return
				}

				cleanup()

				if (message.routerModels) {
					resolve(message.routerModels)
				} else {
					reject(new Error("No router models in response"))
				}
			}
		}

		const cleanup = () => {
			clearTimeout(timeout)
			if (typeof window !== "undefined") {
				window.removeEventListener("message", handler)
			}
			signal?.removeEventListener("abort", onAbort)
		}

		const onAbort = () => {
			cleanup()
			reject(new DOMException("Router models request aborted", "AbortError"))
		}

		// React Query cancels the queryFn when the consuming component unmounts or
		// the query is removed. Honour that signal so the window listener and the
		// timeout do not outlive the request (and a stale response can never
		// resolve a disposed query).
		if (signal) {
			if (signal.aborted) {
				onAbort()
				return
			}
			signal.addEventListener("abort", onAbort, { once: true })
		}

		window.addEventListener("message", handler)
		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: { requestId, ...(provider ? { provider } : {}) },
		})
	})

export const useRouterModels = (opts: UseRouterModelsOptions = {}) => {
	const provider = opts.provider || undefined
	return useQuery({
		queryKey: [RouterModelsMessageType.routerModels, provider || allRouterModelsProvider],
		queryFn: ({ signal }) => fetchRouterModels(provider, signal),
		enabled: opts.enabled !== false,
	})
}
