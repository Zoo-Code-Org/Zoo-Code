import * as vscode from "vscode"

import { toRequestyServiceUrl } from "../shared/utils/requesty"

import { getRouterUnavailableSignInMessage } from "../core/config/routerRemoval"
import { ClineProvider } from "../core/webview/ClineProvider"
import { handleAuthCallback as handleZooCodeAuthCallback, setZooCodeUserInfo } from "../services/zoo-code-auth"

/**
 * Persist the Zoo Code session token to every active provider instance.
 *
 * The profile settings write (handleZooCodeCallback) must run on any active
 * instance — not just the visible one — so the zoo-gateway zooSessionToken is
 * persisted even when the sidebar/panel is hidden at callback time.
 *
 * Run sequentially (NOT Promise.all): each ClineProvider's handleZooCodeCallback
 * does a read-modify-write on the same backing provider settings store
 * (listConfig → getProfile → saveConfig / upsertProviderProfile). Fanning out
 * concurrently across N instances can interleave reads/writes and clobber
 * updates. Serialization is cheap (at most a handful of instances) and avoids
 * the race.
 */
async function propagateZooGatewayCallback(token: string): Promise<void> {
	const allInstances = ClineProvider.getAllInstances()
	for (const instance of allInstances) {
		try {
			await instance.handleZooCodeCallback(token)
		} catch (error) {
			console.error(
				"Failed to persist Zoo Gateway token for a provider instance:",
				error instanceof Error ? error.message : error,
			)
		}
	}
}

export const handleUri = async (uri: vscode.Uri) => {
	const path = uri.path
	const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
	const visibleProvider = ClineProvider.getVisibleInstance()

	switch (path) {
		case "/openrouter": {
			if (!visibleProvider) return
			const code = query.get("code")
			if (code) {
				await visibleProvider.handleOpenRouterCallback(code)
			}
			break
		}
		case "/requesty": {
			if (!visibleProvider) return
			const code = query.get("code")
			const baseUrl = query.get("baseUrl")
			if (code) {
				// Deep links are untrusted. Require consent before installing credentials
				// or redirecting an existing task's conversation to this destination.
				const destination = toRequestyServiceUrl(baseUrl)
				const approve = "Activate Requesty"
				const choice = await vscode.window.showWarningMessage(
					"Activate Requesty credentials from an external link?",
					{
						modal: true,
						detail: `This will replace the active provider. Subsequent requests can send your conversation and workspace content to:\n${JSON.stringify(destination)}\n\nContinue only if you requested these credentials and trust this destination.`,
					},
					approve,
				)
				if (choice === approve) {
					await visibleProvider.handleRequestyCallback(code, baseUrl)
				}
			}
			break
		}
		case "/auth/clerk/callback": {
			vscode.window.showInformationMessage(getRouterUnavailableSignInMessage())
			break
		}
		case "/auth-callback": {
			const token = query.get("token")
			if (token) {
				// Extract user info from callback URL params
				// URLSearchParams.get() already decodes percent-encoded values - no need for decodeURIComponent
				// Use null (not undefined) for missing values to actively clear stale data
				const name = query.get("name") ?? null
				const email = query.get("email") ?? null
				const image = query.get("image") ?? null

				const success = await handleZooCodeAuthCallback(token)
				if (success) {
					// Store user info after successful auth validation (regardless of webview visibility)
					// Always call setZooCodeUserInfo to clear stale data when fields are missing
					await setZooCodeUserInfo({
						name,
						email,
						image,
					})
					await propagateZooGatewayCallback(token)
				}
			}
			break
		}
		default:
			break
	}
}
