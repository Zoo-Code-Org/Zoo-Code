import { OpenAiModelsMessageType, type ExtensionMessage, type ProviderSettings } from "@roo-code/types"

import { vscode } from "@/utils/vscode"

export type OpenAiDiscoverySettings = Pick<ProviderSettings, "openAiBaseUrl" | "openAiApiKey" | "openAiHeaders">

const REQUEST_TIMEOUT_MS = 10_000

/** One independently abortable request; credentials never enter a shared query cache. */
export function discoverOpenAiModels(settings: OpenAiDiscoverySettings, signal: AbortSignal): Promise<string[]> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Model discovery aborted", "AbortError"))
			return
		}

		const requestId = crypto.randomUUID()
		const cleanup = () => {
			clearTimeout(timeout)
			window.removeEventListener("message", onMessage)
			signal.removeEventListener("abort", onAbort)
		}
		const onAbort = () => {
			cleanup()
			reject(new DOMException("Model discovery aborted", "AbortError"))
		}
		const onMessage = (event: MessageEvent<ExtensionMessage | null>) => {
			const message = event.data
			if (message?.type !== OpenAiModelsMessageType.openAiModels || message.requestId !== requestId) return
			cleanup()
			if (message.error) {
				reject(new Error(message.error))
			} else if (
				!Array.isArray(message.openAiModels) ||
				!message.openAiModels.every((id) => typeof id === "string")
			) {
				reject(new Error("Invalid model discovery response"))
			} else {
				resolve(message.openAiModels)
			}
		}
		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Model discovery timed out; configure this model in Settings."))
		}, REQUEST_TIMEOUT_MS)
		window.addEventListener("message", onMessage)
		signal.addEventListener("abort", onAbort, { once: true })
		try {
			vscode.postMessage({
				type: OpenAiModelsMessageType.requestOpenAiModels,
				requestId,
				values: {
					baseUrl: settings.openAiBaseUrl,
					apiKey: settings.openAiApiKey,
					openAiHeaders: settings.openAiHeaders,
				},
			})
		} catch (error) {
			cleanup()
			reject(error)
		}
	})
}
