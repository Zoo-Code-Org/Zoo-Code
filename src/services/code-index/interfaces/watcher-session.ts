import type { Disposable } from "vscode"
import type { IFileWatcher } from "../interfaces"

export interface Session {
	watcher: IFileWatcher
	stopped: boolean
	subscriptions: Disposable[]
	ready: Promise<void>
}
