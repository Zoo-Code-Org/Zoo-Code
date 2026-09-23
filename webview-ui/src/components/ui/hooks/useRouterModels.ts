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
		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Router models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === RouterModelsMessageType.routerModels) {
				const msgProvider = message?.values?.provider as string | undefined

				// Verify response matches request
				if (provider !== msgProvider) {
					// Not our response; ignore and wait for the matching one
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
		if (provider) {
			vscode.postMessage({ type: RouterModelsMessageType.requestRouterModels, values: { provider } })
		} else {
			vscode.postMessage({ type: RouterModelsMessageType.requestRouterModels })
		}
	})

export const useRouterModels = (opts: UseRouterModelsOptions = {}) => {
	const provider = opts.provider || undefined
	return useQuery({
		queryKey: [RouterModelsMessageType.routerModels, provider || allRouterModelsProvider],
		queryFn: ({ signal }) => fetchRouterModels(provider, signal),
		enabled: opts.enabled !== false,
	})
}
