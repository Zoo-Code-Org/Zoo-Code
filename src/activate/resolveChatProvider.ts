import { ClineProvider } from "../core/webview/ClineProvider"
import type { WebviewFocusTracker } from "../core/webview/WebviewFocusTracker"

export async function resolveChatProvider(
	webviewFocusTracker: WebviewFocusTracker,
): Promise<ClineProvider | undefined> {
	const provider = webviewFocusTracker.getLastActiveProvider()
	// Remember chat interaction across editor focus changes, but never target a hidden chat.
	return provider?.isViewVisible ? provider : ClineProvider.getInstance()
}
