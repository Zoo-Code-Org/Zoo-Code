import type * as vscode from "vscode"

import type { CodeIndexManager } from "../manager"

export type CodeIndexStatus = ReturnType<CodeIndexManager["getCurrentStatus"]>

/** Consumer-side port used to replay and publish the active code-index status. */
export interface CodeIndexStatusConsumer {
	readonly onDidCodeIndexWebviewReady: vscode.Event<void>
	postCodeIndexStatus(status: CodeIndexStatus): Promise<void>
}
