import type * as vscode from "vscode"
import type { WebviewMessage } from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"

interface WebviewFocusSource {
	readonly webview: Pick<vscode.Webview, "onDidReceiveMessage">
	readonly onDidDispose: vscode.Event<void>
}

interface TrackedWebview extends vscode.Disposable {
	readonly provider: ClineProvider
	subscriptions: vscode.Disposable[]
}

export class WebviewFocusTracker implements vscode.Disposable {
	private lastFocusedWebview?: TrackedWebview
	private readonly trackedWebviews = new Set<TrackedWebview>()

	public getLastActiveProvider(): ClineProvider | undefined {
		return this.lastFocusedWebview?.provider
	}

	public init(provider: ClineProvider, view: WebviewFocusSource): vscode.Disposable {
		const trackedWebview: TrackedWebview = {
			provider,
			subscriptions: [],
			dispose: () => this.untrackWebview(trackedWebview),
		}
		this.trackedWebviews.add(trackedWebview)

		trackedWebview.subscriptions = [
			view.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(trackedWebview, message)),
			view.onDidDispose(() => trackedWebview.dispose()),
		]

		// An event source may dispose the view while its listeners are being registered.
		if (!this.trackedWebviews.has(trackedWebview)) {
			this.disposeSubscriptions(trackedWebview)
		}

		return trackedWebview
	}

	public dispose() {
		for (const trackedWebview of [...this.trackedWebviews]) {
			trackedWebview.dispose()
		}
		this.lastFocusedWebview = undefined
	}

	private handleMessage(trackedWebview: TrackedWebview, message: WebviewMessage): void {
		if (message.type !== "webviewDidFocus" || !this.trackedWebviews.has(trackedWebview)) {
			return
		}

		this.lastFocusedWebview = trackedWebview
	}

	private untrackWebview(trackedWebview: TrackedWebview): void {
		if (!this.trackedWebviews.delete(trackedWebview)) {
			return
		}

		if (this.lastFocusedWebview === trackedWebview) {
			this.lastFocusedWebview = undefined
		}

		this.disposeSubscriptions(trackedWebview)
	}

	private disposeSubscriptions(trackedWebview: TrackedWebview): void {
		// Drain ownership before invoking callbacks, so failures and reentrant disposal cannot retry listeners.
		for (const subscription of trackedWebview.subscriptions.splice(0)) {
			try {
				subscription.dispose()
			} catch (error) {
				console.error("[WebviewFocusTracker] Failed to dispose webview subscription:", error)
			}
		}
	}
}
