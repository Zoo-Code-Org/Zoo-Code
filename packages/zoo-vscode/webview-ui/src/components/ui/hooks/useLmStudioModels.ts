import { useQuery } from "@tanstack/react-query"

import { type ModelRecord, type ExtensionMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

export const requestLmStudioModels = (baseUrl?: string) =>
	vscode.postMessage({
		type: "requestLmStudioModels",
		values: typeof baseUrl === "string" ? { baseUrl } : undefined,
	})

const getLmStudioModels = async (baseUrl?: string) =>
	new Promise<ModelRecord>((resolve, reject) => {
		const cleanup = () => {
			window.removeEventListener("message", handler)
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("LM Studio models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "lmStudioModels") {
				clearTimeout(timeout)
				cleanup()

				if (message.lmStudioModels) {
					resolve(message.lmStudioModels)
				} else {
					reject(new Error("No LMStudio models in response"))
				}
			}
		}

		window.addEventListener("message", handler)
		requestLmStudioModels(baseUrl)
	})

export const useLmStudioModels = (modelId?: string) =>
	useQuery({
		queryKey: ["lmStudioModels"],
		queryFn: () => (modelId ? getLmStudioModels() : {}),
	})
