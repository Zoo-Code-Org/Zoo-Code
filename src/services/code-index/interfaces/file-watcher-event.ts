import type { Uri } from "vscode"

export interface FileWatcherEvent {
	uri: Uri
	type: "create" | "change" | "delete"
}
