import * as vscode from "vscode"

import { t } from "../../i18n"
import { Package } from "../../shared/package"
import { getCommitContext } from "../../utils/git"
import type { ClineProvider } from "../../core/webview/ClineProvider"

import { getCommitMessageSettings } from "./config"
import { generateCommitMessage as generate } from "./generator"

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

type RepositoryLookup = { repository: GitRepository } | { error: "no-repository" | "ambiguous" }

/**
 * Repositories with a request in flight, and the controller that stops each one.
 *
 * Keyed by repository so that one repository generating does not block another, and holding the
 * controller rather than just the key so `stopGeneratingCommitMessage` - a separate command, and so
 * outside the request entirely - can abort it.
 */
const generating = new Map<string, AbortController>()

/**
 * Swaps the Source Control button between generate and stop.
 *
 * Namespaced like a command id so the nightly build's `zoo-code` -> `zoo-code-nightly` substitution
 * rewrites this key and the `when` clause in package.json that reads it in step: the substitution
 * covers `when`, and `Package.name` is redefined at bundle time.
 */
const GENERATING_CONTEXT_KEY = `${Package.name}.generatingCommitMessage`

/**
 * Context keys are workspace-wide, so this is true while *any* repository is generating. In a
 * multi-repository workspace that means the stop button also appears on repositories with nothing
 * in flight; stopping one of those does nothing.
 */
const publishGeneratingContext = () =>
	vscode.commands.executeCommand("setContext", GENERATING_CONTEXT_KEY, generating.size > 0)

// Symbols rather than sentinel strings, so no model output can ever be mistaken for one of them.
const CANCELLED = Symbol("cancelled")
const TIMED_OUT = Symbol("timed-out")

/**
 * Resolves the repository whose commit input box should be filled.
 *
 * The SCM menus pass the `SourceControl` that was clicked, which identifies the repository
 * exactly. Without one - from the Command Palette, say - the only unambiguous case is a workspace
 * with a single repository. Guessing would eventually write a message describing another
 * repository's changes, which is worse than writing nothing.
 */
async function findRepository(sourceControl?: vscode.SourceControl): Promise<RepositoryLookup> {
	const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git")

	if (!extension) {
		return { error: "no-repository" }
	}

	if (!extension.isActive) {
		await extension.activate()
	}

	const repositories = extension.exports?.getAPI(1).repositories ?? []
	const clickedPath = sourceControl?.rootUri?.fsPath

	if (clickedPath) {
		const match = repositories.find((repo) => repo.rootUri.fsPath === clickedPath)
		return match ? { repository: match } : { error: "no-repository" }
	}

	if (repositories.length === 1) {
		return { repository: repositories[0] }
	}

	return { error: repositories.length === 0 ? "no-repository" : "ambiguous" }
}

/**
 * Generates a commit message from the current changes and writes it into the Source Control input
 * box, using the profile chosen in Settings → Providers → Commit Message Model.
 *
 * Everything the user has typed is left alone: this only ever writes into a box that was empty
 * when generation started and is still empty when it finishes.
 */
export async function generateCommitMessage(
	provider: ClineProvider,
	sourceControl?: vscode.SourceControl,
): Promise<void> {
	try {
		const lookup = await findRepository(sourceControl)

		if ("error" in lookup) {
			vscode.window.showErrorMessage(
				t(
					lookup.error === "ambiguous"
						? "common:errors.commit_message_ambiguous_repository"
						: "common:errors.commit_message_no_repository",
				),
			)

			return
		}

		const { repository } = lookup
		const repositoryKey = repository.rootUri.fsPath

		if (generating.has(repositoryKey)) {
			vscode.window.showInformationMessage(t("common:info.commit_message_already_generating"))
			return
		}

		// Registered before anything slow runs, so the button is a stop button for the whole of the
		// request rather than only once the model has been reached.
		const controller = new AbortController()
		generating.set(repositoryKey, controller)
		await publishGeneratingContext()

		try {
			// Captured before anything slow runs, so an edit made during generation is detectable.
			const draft = repository.inputBox.value

			if (draft.trim()) {
				vscode.window.showInformationMessage(t("common:info.commit_message_box_not_empty"))
				return
			}

			const result = await getCommitContext(repository.rootUri.fsPath)

			if (!result.ok) {
				if (result.reason === "nothing-staged") {
					// Only the index is described, so this is the one failure the user can fix
					// directly - the message says how rather than just reporting nothing happened.
					vscode.window.showInformationMessage(t("common:info.commit_message_nothing_staged"))
				} else if (result.reason === "no-changes") {
					vscode.window.showInformationMessage(t("common:info.commit_message_no_changes"))
				} else if (result.reason === "failed") {
					vscode.window.showErrorMessage(
						t("common:errors.commit_message_failed", { error: result.error ?? result.reason }),
					)
				} else {
					// `git-missing` and `not-a-repo` both mean there is nothing here to describe.
					vscode.window.showErrorMessage(t("common:errors.commit_message_no_repository"))
				}

				return
			}

			// Collecting the diff is the one phase that cannot be interrupted - `getCommitContext`
			// shells out to git and takes no signal - so a stop pressed during it lands here.
			if (controller.signal.aborted) {
				return
			}

			const { apiConfiguration, customSupportPrompts, timeoutMs } = await getCommitMessageSettings(provider)

			// `ProgressLocation.SourceControl` draws an indeterminate bar in the Source Control view
			// header and drops the title, which is what this wants: the button directly beneath it
			// has already become a stop button, so nothing has to say so in words.
			const outcome: string | typeof CANCELLED | typeof TIMED_OUT = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.SourceControl },
				async () => {
					// The bound that makes this safe on every provider. Only a handful forward the
					// abort signal to the underlying request, so a stalled provider cannot be
					// stopped - but it can be stopped being waited on, which is what frees the user.
					// Both routes abort the same controller, so a flag is what tells them apart.
					let timedOut = false

					const timer = setTimeout(() => {
						timedOut = true
						controller.abort()
					}, timeoutMs)

					const aborted = new Promise<typeof CANCELLED | typeof TIMED_OUT>((resolve) => {
						const settle = () => resolve(timedOut ? TIMED_OUT : CANCELLED)

						// A signal aborted before the listener is attached never fires `abort`.
						if (controller.signal.aborted) {
							settle()
						} else {
							controller.signal.addEventListener("abort", settle, { once: true })
						}
					})

					// Providers that honour the signal reject once it is aborted. That rejection
					// describes the cancellation the user asked for, not a failure worth reporting,
					// so it resolves to the matching sentinel instead of propagating as an error.
					const request = generate({
						context: result.context,
						apiConfiguration,
						customSupportPrompts,
						abortSignal: controller.signal,
					}).catch((error) => {
						if (controller.signal.aborted) {
							return timedOut ? TIMED_OUT : CANCELLED
						}

						throw error
					})

					try {
						// Whichever settles first wins: the indicator closes and the repository is
						// released even when the request itself keeps running, and whatever it
						// eventually returns is dropped.
						return await Promise.race([request, aborted])
					} finally {
						clearTimeout(timer)
					}
				},
			)

			// Cancelling is the user's own doing, so it passes without comment. A timeout is not - it
			// looks identical from the box, so it has to say why nothing was written.
			if (outcome === TIMED_OUT) {
				vscode.window.showErrorMessage(t("common:errors.commit_message_timeout", { seconds: timeoutMs / 1000 }))
				return
			}

			if (outcome === CANCELLED) {
				return
			}

			const message = outcome

			// The box was empty when this started. If it no longer is, the user typed while the request
			// was in flight and their text wins.
			if (repository.inputBox.value !== draft) {
				vscode.window.showInformationMessage(t("common:info.commit_message_box_not_empty"))
				return
			}

			repository.inputBox.value = message
		} finally {
			generating.delete(repositoryKey)
			await publishGeneratingContext()
		}
	} catch (error) {
		vscode.window.showErrorMessage(
			t("common:errors.commit_message_failed", {
				error: error instanceof Error ? error.message : String(error),
			}),
		)
	}
}

/**
 * Stops the generation running in the clicked repository, leaving the input box as it was.
 *
 * Nothing is reported either way. Stopping is the user's own doing, which is already why a stopped
 * request writes no message and shows no error.
 */
export async function stopGeneratingCommitMessage(sourceControl?: vscode.SourceControl): Promise<void> {
	const lookup = await findRepository(sourceControl)

	// The button is shown by a workspace-wide context key, so it is also on repositories with
	// nothing in flight. There it does nothing, rather than guessing at which repository was meant.
	if ("repository" in lookup) {
		generating.get(lookup.repository.rootUri.fsPath)?.abort()
	}
}
