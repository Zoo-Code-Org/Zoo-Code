import * as vscode from "vscode"

import { VsCodeLmModelsMessageType, githubCopilotLanguageModel } from "@roo-code/types"

import { getVsCodeLmModels } from "../../api/providers/vscode-lm"

export interface CopilotModelBroadcastTarget {
	postMessageToWebview(message: {
		type: typeof VsCodeLmModelsMessageType.githubCopilotModels
		vsCodeLmModels: Awaited<ReturnType<typeof getVsCodeLmModels>>
	}): Promise<void>
}

export interface CopilotModelBroadcastOptions {
	/** The webviews to keep current; resolved on every broadcast so views opened later are included. */
	getTargets: () => readonly CopilotModelBroadcastTarget[]
	log: (message: string) => void
	/** Collapses the burst of events VS Code raises while models register into one refresh. */
	debounceMs?: number
	subscribe?: (listener: () => void) => vscode.Disposable | undefined
	fetchModels?: typeof getVsCodeLmModels
}

const DEFAULT_DEBOUNCE_MS = 250

/**
 * Keeps every open webview's Copilot model list current as the host registers or removes models
 * (sign-in, sign-out, entitlement changes).
 *
 * One subscription serves all views, so a change costs one lookup however many views exist. A failed
 * lookup is logged and leaves each view's last known list in place: reporting failure as "no models"
 * would wrongly present a transient error as a lost entitlement.
 */
export function registerCopilotModelBroadcast(options: CopilotModelBroadcastOptions): vscode.Disposable {
	const {
		getTargets,
		log,
		debounceMs = DEFAULT_DEBOUNCE_MS,
		subscribe = (listener) => ("lm" in vscode ? vscode.lm.onDidChangeChatModels?.(listener) : undefined),
		fetchModels = getVsCodeLmModels,
	} = options

	let timer: ReturnType<typeof setTimeout> | undefined
	let latestRequest = 0
	let disposed = false

	const refresh = async () => {
		const request = ++latestRequest
		try {
			const vsCodeLmModels = await fetchModels(githubCopilotLanguageModel.selector)
			// A newer change superseded this lookup, or the extension is shutting down.
			if (disposed || request !== latestRequest) return
			await Promise.all(
				getTargets().map((target) =>
					target.postMessageToWebview({
						type: VsCodeLmModelsMessageType.githubCopilotModels,
						vsCodeLmModels,
					}),
				),
			)
		} catch (error) {
			log(`Failed to refresh GitHub Copilot models: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	const subscription = subscribe(() => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => void refresh(), debounceMs)
	})

	return {
		dispose() {
			disposed = true
			if (timer) clearTimeout(timer)
			subscription?.dispose()
		},
	}
}
