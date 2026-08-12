import type { ProviderSettings } from "@roo-code/types"

import { t } from "../../i18n"
import { supportPrompt } from "../../shared/support-prompt"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import type { CommitContext, GitFileChange } from "../../utils/git"

/** As stored in settings, where a prompt may be present but left unset. */
export type CustomSupportPrompts = Record<string, string | undefined>

export interface GenerateCommitMessageOptions {
	context: CommitContext
	apiConfiguration: ProviderSettings
	customSupportPrompts?: CustomSupportPrompts
	/**
	 * Aborts the request. Only some providers forward this to the underlying HTTP call, so callers
	 * must treat it as best-effort and stop waiting on their own rather than assuming it lands.
	 */
	abortSignal?: AbortSignal
}

/** One file per line, with renames and copies showing where they came from. */
function formatChangedFiles(files: GitFileChange[]): string {
	return files
		.map((file) =>
			file.oldPath ? `- ${file.status}: ${file.oldPath} -> ${file.path}` : `- ${file.status}: ${file.path}`,
		)
		.join("\n")
}

/**
 * Fills the commit message prompt, which the user can edit in Settings → Prompts. The pieces are
 * separate placeholders so a custom prompt can drop or reorder any of them.
 */
export function buildCommitMessagePrompt(context: CommitContext, customSupportPrompts?: CustomSupportPrompts): string {
	return supportPrompt.create(
		"COMMIT_MESSAGE",
		{
			branch: context.branch ?? "(detached HEAD)",
			recentCommits: context.recentCommits.map((subject) => `- ${subject}`).join("\n"),
			changedFiles: formatChangedFiles(context.files),
			diff: context.diff,
		},
		customSupportPrompts,
	)
}

/** Models tend to wrap their answer in code fences or quotes despite being told not to. */
export function cleanCommitMessage(message: string): string {
	return message
		.replace(/```[^\n]*\n?|```/g, "")
		.trim()
		.replace(/^["'`]|["'`]$/g, "")
		.trim()
}

/**
 * Turns collected git context into a commit message.
 *
 * Deliberately knows nothing about VS Code: it neither locates a repository nor writes anywhere,
 * so it can be exercised without the extension host. Callers own everything to do with the UI.
 *
 * @throws when the model returns nothing usable, so that a caller never writes an empty message
 * over what the user already typed.
 */
export async function generateCommitMessage({
	context,
	apiConfiguration,
	customSupportPrompts,
	abortSignal,
}: GenerateCommitMessageOptions): Promise<string> {
	const prompt = buildCommitMessagePrompt(context, customSupportPrompts)
	const message = cleanCommitMessage(await singleCompletionHandler(apiConfiguration, prompt, { abortSignal }))

	if (!message) {
		throw new Error(t("common:errors.commit_message_empty_response"))
	}

	return message
}
