import type { ExtensionMessage, ProviderInfoKind, ProviderInfoParams, ProviderInfoResultMap } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

// Longer than every host-side fetch timeout (15 s at most), so the host answers first.
const TIMEOUT_MS = 20_000

/** Ask the extension host to run a provider lookup. The webview CSP allows no provider origins. */
export const requestProviderInfo = <K extends ProviderInfoKind>(
	kind: K,
	params: ProviderInfoParams,
	signal?: AbortSignal,
): Promise<ProviderInfoResultMap[K]> =>
	new Promise<ProviderInfoResultMap[K]>((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Provider info request aborted", "AbortError"))
		const requestId = crypto.randomUUID()

		const cleanup = (error?: unknown) => {
			clearTimeout(timeout)
			window.removeEventListener("message", handler)
			signal?.removeEventListener("abort", onAbort)
			if (error !== undefined) reject(error)
		}
		const onAbort = () => cleanup(new DOMException("Provider info request aborted", "AbortError"))

		const timeout = setTimeout(() => cleanup(new Error("Provider info request timed out")), TIMEOUT_MS)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message?.type !== "providerInfo" || message.requestId !== requestId) return

			cleanup()

			if (message.error) {
				reject(new Error(message.error))
			} else {
				resolve(message.values?.data as ProviderInfoResultMap[K])
			}
		}

		window.addEventListener("message", handler)
		signal?.addEventListener("abort", onAbort, { once: true })
		try {
			vscode.postMessage({ type: "requestProviderInfo", requestId, values: { kind, ...params } })
		} catch (error) {
			cleanup(error)
		}
	})
