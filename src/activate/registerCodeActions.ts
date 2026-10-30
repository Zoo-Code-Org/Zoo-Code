import * as vscode from "vscode"

import { CodeActionId, CodeActionName } from "@roo-code/types"

import { getCodeActionCommand } from "../utils/commands"
import { EditorUtils } from "../integrations/editor/EditorUtils"
import type { WebviewFocusTracker } from "../core/webview/WebviewFocusTracker"
import { resolveChatProvider } from "./resolveChatProvider"

export const registerCodeActions = (context: vscode.ExtensionContext, webviewFocusTracker: WebviewFocusTracker) => {
	registerCodeAction(context, "explainCode", "EXPLAIN", webviewFocusTracker)
	registerCodeAction(context, "fixCode", "FIX", webviewFocusTracker)
	registerCodeAction(context, "improveCode", "IMPROVE", webviewFocusTracker)
	registerCodeAction(context, "addToContext", "ADD_TO_CONTEXT", webviewFocusTracker)
}

const registerCodeAction = (
	context: vscode.ExtensionContext,
	command: CodeActionId,
	promptType: CodeActionName,
	webviewFocusTracker: WebviewFocusTracker,
) => {
	let userInput: string | undefined

	context.subscriptions.push(
		vscode.commands.registerCommand(getCodeActionCommand(command), async (...args: any[]) => {
			// Handle both code action and direct command cases.
			let filePath: string
			let selectedText: string
			let startLine: number | undefined
			let endLine: number | undefined
			let diagnostics: any[] | undefined

			if (args.length > 1) {
				// Called from code action.
				;[filePath, selectedText, startLine, endLine, diagnostics] = args
			} else {
				// Called directly from command palette.
				const context = EditorUtils.getEditorContext()

				if (!context) {
					return
				}

				;({ filePath, selectedText, startLine, endLine, diagnostics } = context)
			}

			const params = {
				...{ filePath, selectedText },
				...(startLine !== undefined ? { startLine: startLine.toString() } : {}),
				...(endLine !== undefined ? { endLine: endLine.toString() } : {}),
				...(diagnostics ? { diagnostics } : {}),
				...(userInput ? { userInput } : {}),
			}

			// Capture the destination before focus returns from the source editor to a chat.
			const targetProvider = await resolveChatProvider(webviewFocusTracker)
			await targetProvider?.handleCodeAction(command, promptType, params)
		}),
	)
}
