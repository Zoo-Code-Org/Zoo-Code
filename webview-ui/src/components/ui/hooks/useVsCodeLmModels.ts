import { useQuery } from "@tanstack/react-query"
import { type LanguageModelChatSelector } from "vscode"

import { type ExtensionMessage, VsCodeLmModelsMessageType } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

const getVsCodeLmModels = async (signal?: AbortSignal) =>
	new Promise<LanguageModelChatSelector[]>((resolve, reject) => {
		let settled = false
		const cleanup = () => {
			window.removeEventListener("message", handler)
			clearTimeout(timeout)
		}

		const finish = (fn: () => void) => {
			if (settled || signal?.aborted) {
				return
			}
			settled = true
			cleanup()
			fn()
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

		signal?.addEventListener("abort", () => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			reject(new DOMException("Aborted", "AbortError"))
		})

		window.addEventListener("message", handler)
		vscode.postMessage({ type: VsCodeLmModelsMessageType.requestVsCodeLmModels })
	})

export const useVsCodeLmModels = (enabled: boolean) =>
	useQuery({
		queryKey: ["vsCodeLmModels"],
		queryFn: ({ signal }) => (enabled ? getVsCodeLmModels(signal) : []),
	})
