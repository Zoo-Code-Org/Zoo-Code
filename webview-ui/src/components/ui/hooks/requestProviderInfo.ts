import type { ExtensionMessage, ProviderInfoKind, ProviderInfoParams } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

const TIMEOUT_MS = 15_000

/** Ask the extension host to run a provider lookup. The webview CSP allows no provider origins. */
export const requestProviderInfo = <T>(kind: ProviderInfoKind, params: ProviderInfoParams): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const requestId = crypto.randomUUID()

		const cleanup = () => {
			clearTimeout(timeout)
			window.removeEventListener("message", handler)
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Provider info request timed out"))
		}, TIMEOUT_MS)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type !== "providerInfo" || message.requestId !== requestId) return

			cleanup()

			if (message.error) {
				reject(new Error(message.error))
			} else {
				resolve(message.values?.data as T)
			}
		}

		window.addEventListener("message", handler)
		vscode.postMessage({ type: "requestProviderInfo", requestId, values: { kind, ...params } })
	})
