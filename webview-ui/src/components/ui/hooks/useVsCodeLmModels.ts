import { useQuery } from "@tanstack/react-query"
import { type LanguageModelChatSelector } from "vscode"

import { type ExtensionMessage, VsCodeLmModelsMessageType } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

// The query key is a constant ("vsCodeLmModels"), so at most one in-flight
// request can exist at any moment. No requestId correlation is needed: if
// React Query retries, it aborts the previous signal before firing the next
// request, so responses are always matched to the current queryFn invocation.
const getVsCodeLmModels = async (signal?: AbortSignal) =>
	new Promise<LanguageModelChatSelector[]>((resolve, reject) => {
		let settled = false

		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			fn()
		}

		const handleAbort = () => {
			if (settled) return
			settled = true
			cleanup()
			reject(new DOMException("Aborted", "AbortError"))
		}

		const cleanup = () => {
			window.removeEventListener("message", handler)
			signal?.removeEventListener("abort", handleAbort)
			clearTimeout(timeout)
		}

		// If the signal is already aborted, reject immediately without
		// registering listeners or starting a timer.
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"))
			return
		}

		const timeout = setTimeout(() => {
			finish(() => reject(new Error("VS Code LM models request timed out")))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === VsCodeLmModelsMessageType.vsCodeLmModels) {
				finish(() => resolve(message.vsCodeLmModels ?? []))
			}
		}

		signal?.addEventListener("abort", handleAbort, { once: true })
		window.addEventListener("message", handler)
		vscode.postMessage({ type: VsCodeLmModelsMessageType.requestVsCodeLmModels })
	})

export const useVsCodeLmModels = (enabled: boolean) =>
	useQuery({
		queryKey: ["vsCodeLmModels"],
		queryFn: ({ signal }) => (enabled ? getVsCodeLmModels(signal) : []),
	})
