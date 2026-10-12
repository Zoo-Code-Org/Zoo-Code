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
		let timeout: ReturnType<typeof setTimeout> | undefined

		const cleanup = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout)
				timeout = undefined
			}
			signal?.removeEventListener("abort", abortHandler)
			if (typeof window !== "undefined") {
				window.removeEventListener("message", handler)
			}
		}

		if (signal?.aborted) {
			reject(new Error("Router models request aborted"))
			return
		}

		const abortHandler = () => {
			cleanup()
			reject(new Error("Router models request aborted"))
		}

		timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Router models request timed out"))
		}, 10000)

		signal?.addEventListener("abort", abortHandler, { once: true })

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
