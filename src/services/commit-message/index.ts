import * as vscode from "vscode"

import type { ProviderSettings } from "@roo-code/types"

import { t } from "../../i18n"
import { supportPrompt } from "../../shared/support-prompt"
import { getCommitContext } from "../../utils/git"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import type { ClineProvider } from "../../core/webview/ClineProvider"

/**
 * The slice of the built-in Git extension's API that we depend on. Declared structurally so we
 * don't have to vendor `git.d.ts` for three properties.
 */
interface GitRepository {
	rootUri: vscode.Uri
	inputBox: { value: string }
}

interface GitApi {
	repositories: GitRepository[]
}

interface GitExtensionExports {
	getAPI(version: 1): GitApi
}

/**
 * Resolves the repository whose commit input box should be filled.
 *
 * The `scm/title` menu passes the `SourceControl` that was clicked, which lets us pick the right
 * repository in a multi-root workspace. When that isn't available we fall back to the first one.
 */
async function findRepository(sourceControl?: vscode.SourceControl): Promise<GitRepository | undefined> {
	const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git")

	if (!extension) {
		return undefined
	}

	if (!extension.isActive) {
		await extension.activate()
	}

	const repositories = extension.exports?.getAPI(1).repositories ?? []
	const clickedPath = sourceControl?.rootUri?.fsPath

	if (clickedPath) {
		const match = repositories.find((repo) => repo.rootUri.fsPath === clickedPath)

		if (match) {
			return match
		}
	}

	return repositories[0]
}

/**
 * Models tend to wrap their answer in code fences or quotes despite being told not to.
 */
function cleanCommitMessage(message: string): string {
	return message
		.replace(/```[a-z]*\n?|```/g, "")
		.trim()
		.replace(/^["'`]|["'`]$/g, "")
		.trim()
}

/**
 * Generates a commit message from the current changes and writes it into the Source Control input
 * box. Prefers the profile chosen in Settings → Providers → Commit Message Model, falling back to
 * the currently active profile.
 */
export async function generateCommitMessage(
	provider: ClineProvider,
	sourceControl?: vscode.SourceControl,
): Promise<void> {
	try {
		const repository = await findRepository(sourceControl)

		if (!repository) {
			vscode.window.showErrorMessage(t("common:errors.commit_message_no_repository"))
			return
		}

		const gitContext = await getCommitContext(repository.rootUri.fsPath)

		if (!gitContext) {
			vscode.window.showInformationMessage(t("common:info.commit_message_no_changes"))
			return
		}

		const { apiConfiguration, listApiConfigMeta, customSupportPrompts, commitMessageApiConfigId } =
			await provider.getState()

		// Fall back to the active configuration when no dedicated profile is set, or when the saved
		// one has since been deleted (`getProfile` throws on an unknown id).
		let configToUse: ProviderSettings = apiConfiguration

		if (commitMessageApiConfigId && listApiConfigMeta?.find(({ id }) => id === commitMessageApiConfigId)) {
			const { name: _, ...providerSettings } = await provider.providerSettingsManager.getProfile({
				id: commitMessageApiConfigId,
			})

			if (providerSettings.apiProvider) {
				configToUse = providerSettings
			}
		}

		const prompt = supportPrompt.create("COMMIT_MESSAGE", { gitContext }, customSupportPrompts)

		// `ProgressLocation.Window` shows the title in the status bar. `SourceControl` only spins
		// the SCM icon and drops the title entirely.
		//
		// No cancel button: only `ProgressLocation.Notification` renders one, and a toast on every
		// commit would be intrusive. Cancellation would be inert anyway - `completePrompt` accepts
		// an `abortSignal`, but nearly every provider (Ollama included) ignores the argument, so
		// the underlying request cannot actually be interrupted today.
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: t("common:info.commit_message_generating"),
			},
			async () => {
				const message = await singleCompletionHandler(configToUse, prompt)
				repository.inputBox.value = cleanCommitMessage(message)
			},
		)
	} catch (error) {
		vscode.window.showErrorMessage(
			t("common:errors.commit_message_failed", {
				error: error instanceof Error ? error.message : String(error),
			}),
		)
	}
}
