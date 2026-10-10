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
		const requestId = crypto.randomUUID()
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const abort = () => {
			cleanup()
			vscode.postMessage({ type: "cancelModelRequest", requestId })
			reject(signal?.reason ?? new Error("Router models request aborted"))
		}
		const cleanup = () => {
			clearTimeout(timeout)
			signal?.removeEventListener("abort", abort)
			if (typeof window !== "undefined") {
				window.removeEventListener("message", handler)
			}
		}

		const timeout = setTimeout(() => {
			cleanup()
			vscode.postMessage({ type: "cancelModelRequest", requestId })
			reject(new Error("Router models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === RouterModelsMessageType.routerModels) {
				const msgProvider = message?.values?.provider as string | undefined

				// Verify response matches request
				if (provider !== msgProvider || (message.requestId !== undefined && message.requestId !== requestId)) {
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

		signal?.addEventListener("abort", abort, { once: true })
		window.addEventListener("message", handler)
		if (provider) {
			vscode.postMessage({ type: RouterModelsMessageType.requestRouterModels, requestId, values: { provider } })
		} else {
			vscode.postMessage({ type: RouterModelsMessageType.requestRouterModels, requestId })
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
