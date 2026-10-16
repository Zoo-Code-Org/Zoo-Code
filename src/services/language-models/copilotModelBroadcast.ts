import * as vscode from "vscode"

import { VsCodeLmModelsMessageType, githubCopilotLanguageModel } from "@roo-code/types"

import { getGitHubCopilotAccount, getGitHubCopilotModels } from "../../api/providers/github-copilot"
import { getGitHubCopilotViewState } from "./copilotViewState"

export interface CopilotModelBroadcastTarget {
	postMessageToWebview(message: {
		type: typeof VsCodeLmModelsMessageType.githubCopilotModels
		vsCodeLmModels: Awaited<ReturnType<typeof getGitHubCopilotModels>>
		githubCopilotAccount: string | null
	}): Promise<void>
}

export interface CopilotModelBroadcastOptions {
	/** The webviews to keep current; resolved on every broadcast so views opened later are included. */
	getTargets: () => readonly CopilotModelBroadcastTarget[]
	log: (message: string) => void
	/** Collapses the burst of events VS Code raises while models register into one refresh. */
	debounceMs?: number
	/** Calls the listener when the host's models or its GitHub sessions change. */
	subscribe?: (listener: () => void) => vscode.Disposable | undefined
	fetchModels?: typeof getGitHubCopilotModels
	fetchAccount?: typeof getGitHubCopilotAccount
}

const DEFAULT_DEBOUNCE_MS = 250

const subscribeToHost = (listener: () => void): vscode.Disposable => {
	const subscriptions = [
		"lm" in vscode ? vscode.lm.onDidChangeChatModels?.(listener) : undefined,
		"authentication" in vscode
			? vscode.authentication.onDidChangeSessions?.((event) => {
					if (event.provider.id === githubCopilotLanguageModel.authProviderId) listener()
				})
			: undefined,
	]
	return { dispose: () => subscriptions.forEach((subscription) => subscription?.dispose()) }
}

/**
 * Keeps every open webview's Copilot account and model list current as the host registers or removes
 * models and as GitHub sessions change, including a sign-out done in VS Code's own account menu.
 *
 * One subscription serves all views, so a change costs one lookup however many views exist. A failed
 * lookup is logged and leaves each view's last known state in place: reporting failure as "signed out"
 * or "no models" would wrongly present a transient error as a lost account or entitlement. A view that
 * signed in while the lookup ran is skipped, since its own result is newer.
 */
export function registerCopilotModelBroadcast(options: CopilotModelBroadcastOptions): vscode.Disposable {
	const {
		getTargets,
		log,
		debounceMs = DEFAULT_DEBOUNCE_MS,
		subscribe = subscribeToHost,
		fetchModels = getGitHubCopilotModels,
		fetchAccount = getGitHubCopilotAccount,
	} = options

	let timer: ReturnType<typeof setTimeout> | undefined
	let latestRequest = 0
	let disposed = false

	const refresh = async () => {
		const request = ++latestRequest
		const started = new Map(
			getTargets().map((target) => {
				const state = getGitHubCopilotViewState(target)
				return [target, { changes: state.changes, refreshId: state.refreshId }]
			}),
		)
		try {
			const [vsCodeLmModels, account] = await Promise.all([fetchModels(), fetchAccount()])
			// A newer change superseded this lookup, or the extension is shutting down.
			if (disposed || request !== latestRequest) return
			await Promise.all(
				getTargets()
					.filter((target) => {
						const atStart = started.get(target)
						const state = getGitHubCopilotViewState(target)
						return !atStart || (state.changes === atStart.changes && state.refreshId === atStart.refreshId)
					})
					.map((target) => {
						// Claimed only when posting, so a failed or superseded lookup never strands a manual refresh.
						getGitHubCopilotViewState(target).refreshId++
						return target.postMessageToWebview({
							type: VsCodeLmModelsMessageType.githubCopilotModels,
							vsCodeLmModels,
							githubCopilotAccount: account ?? null,
						})
					}),
			)
		} catch (error) {
			log(`Failed to refresh GitHub Copilot state: ${error instanceof Error ? error.message : String(error)}`)
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
