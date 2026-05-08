import * as vscode from "vscode"

import { getRouterUnavailableSignInMessage } from "../core/config/routerRemoval"
import { ClineProvider } from "../core/webview/ClineProvider"
import { handleAuthCallback as handleZooCodeAuthCallback, setZooCodeUserInfo } from "../services/zoo-code-auth"

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
				await visibleProvider.handleRequestyCallback(code, baseUrl)
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
				const name = query.get("name") ?? undefined
				const email = query.get("email") ?? undefined
				const image = query.get("image") ?? undefined

				const success = await handleZooCodeAuthCallback(token)
				if (success) {
					// Store user info after successful auth validation (regardless of webview visibility)
					if (name || email || image) {
						await setZooCodeUserInfo({
							name,
							email,
							image,
						})
					}
					// Refresh webview state if a panel is currently open
					if (visibleProvider) {
						await visibleProvider.handleZooCodeCallback(token)
					}
				}
			}
			break
		}
		default:
			break
	}
}
