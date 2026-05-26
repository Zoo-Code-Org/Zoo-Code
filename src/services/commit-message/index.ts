import * as vscode from "vscode"
import { CommitMessageProvider } from "./CommitMessageProvider"
import { t } from "../../i18n"

/** Registers the commit message provider and reports activation failures to the output channel. */
export function registerCommitMessageProvider(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): void {
	const commitProvider = new CommitMessageProvider(context, outputChannel)
	context.subscriptions.push(commitProvider)

	commitProvider.activate().catch((error) => {
		outputChannel.appendLine(t("common:commitMessage.activationFailed", { error: error.message }))
		console.error("Commit message provider activation failed:", error)
	})

	outputChannel.appendLine(t("common:commitMessage.providerRegistered"))
}
