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
		// Request identity lets the extension host abort this specific fetch when the webview
		// cancels (see cancelRouterModelsRequest in webviewMessageHandler).
		const requestId = crypto.randomUUID()
		// Set once the request message has been posted; a cancellation is only forwarded for
		// requests the extension host actually received.
		let requestPosted = false

		const cleanup = () => {
			if (typeof window !== "undefined") {
				window.removeEventListener("message", handler)
			}
			signal?.removeEventListener("abort", onAbort)
		}

		const onAbort = () => {
			clearTimeout(timeout)
			cleanup()
			// Fire-and-forget: ask the extension host to abort the matching in-flight fetch.
			// Only when the request was actually posted -- a pre-aborted signal never reaches
			// the host, so there is nothing to cancel there.
			if (requestPosted) {
				void vscode.postMessage({
					type: RouterModelsMessageType.cancelRouterModelsRequest,
					values: { requestId },
				})
			}
			// Match the repo abort contract (abort-signal.ts): name "AbortError"
			// so cancellation is recognizable by callers and React Query.
			const abortError = new Error("Aborted")
			abortError.name = "AbortError"
			reject(abortError)
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
				if (provider !== msgProvider) {
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

		window.addEventListener("message", handler)

		if (signal?.aborted) {
			onAbort()
			return
		}
		signal?.addEventListener("abort", onAbort)

		if (provider) {
			vscode.postMessage({
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider, requestId },
			})
		} else {
			vscode.postMessage({
				type: RouterModelsMessageType.requestRouterModels,
				values: { requestId },
			})
		}
		requestPosted = true
	})

export const useRouterModels = (opts: UseRouterModelsOptions = {}) => {
	const provider = opts.provider || undefined
	return useQuery({
		queryKey: [RouterModelsMessageType.routerModels, provider || allRouterModelsProvider],
		queryFn: ({ signal }) => fetchRouterModels(provider, signal),
		enabled: opts.enabled !== false,
	})
}
