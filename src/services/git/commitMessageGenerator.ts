import * as vscode from "vscode"
import type { ProviderSettings } from "@roo-code/types"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { truncateOutput } from "../../integrations/misc/extract-text"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

export interface GitRepository {
	readonly rootUri: vscode.Uri
	readonly inputBox: {
		value: string
	}
	diff(cached?: boolean): Promise<string>
}

export interface GitAPI {
	readonly repositories: readonly GitRepository[]
}

export interface GitExtension {
	readonly enabled?: boolean
	getAPI(version: 1): GitAPI
}

export interface GenerateCommitMessageOptions {
	provider: ClineProvider
	outputChannel?: vscode.OutputChannel
	context?: unknown
}

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are an expert developer specializing in Git commit messages.
Generate a concise, meaningful Git commit message for the provided diff following the Conventional Commits specification (v1.0.0).

Guidelines:
1. Format: <type>(<optional scope>): <description>
   [optional body]
   [optional footer(s)]
2. Common types:
   - feat: A new feature
   - fix: A bug fix
   - docs: Documentation changes
   - style: Formatting or code style changes (no logic change)
   - refactor: Refactoring code without changing behavior
   - perf: Performance improvements
   - test: Adding or updating tests
   - build: Changes affecting build systems or dependencies
   - ci: CI/CD configuration changes
   - chore: Other maintenance changes
3. Use imperative, present tense ("add" not "added", "fix" not "fixes").
4. Keep the subject line within 72 characters and do not end with a period.
5. If the changes warrant explanation, include a blank line followed by a concise body or bullet points detailing what changed and why.
6. Return ONLY the commit message. Do NOT include markdown code blocks, quotes, or any introductory or concluding text.`

/**
 * Accesses the VS Code Git extension API.
 */
export async function getGitApi(): Promise<GitAPI | undefined> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")
	if (!gitExtension) {
		return undefined
	}
	if (!gitExtension.isActive) {
		await gitExtension.activate()
	}
	return gitExtension.exports?.getAPI(1)
}

/**
 * Resolves the appropriate Git repository given an optional SCM invocation context.
 */
export function resolveGitRepository(git: GitAPI, context?: unknown): GitRepository | undefined {
	if (!git.repositories || git.repositories.length === 0) {
		return undefined
	}

	if (context && typeof context === "object") {
		const candidate = context as Partial<GitRepository>
		if (typeof candidate.diff === "function" && candidate.inputBox && typeof candidate.inputBox === "object") {
			return candidate as GitRepository
		}

		const sc = context as { rootUri?: vscode.Uri; inputBox?: unknown }
		if (sc.rootUri) {
			const found = git.repositories.find((r) => r.rootUri.toString() === sc.rootUri?.toString())
			if (found) {
				return found
			}
		}

		if (sc.inputBox) {
			const found = git.repositories.find((r) => r.inputBox === sc.inputBox)
			if (found) {
				return found
			}
		}
	}

	if (git.repositories.length === 1) {
		return git.repositories[0]
	}

	const activeDocUri = vscode.window.activeTextEditor?.document.uri
	if (activeDocUri) {
		const found = git.repositories.find((r) => activeDocUri.fsPath.startsWith(r.rootUri.fsPath))
		if (found) {
			return found
		}
	}

	return git.repositories[0]
}

/**
 * Retrieves diff from the repository, prioritizing staged changes and falling back to working tree changes.
 */
export async function getRepositoryDiff(repository: GitRepository): Promise<string | undefined> {
	let diff = ""
	try {
		diff = await repository.diff(true)
	} catch {
		// Staged diff failed, continue to working tree diff
	}

	if (!diff || !diff.trim()) {
		try {
			diff = await repository.diff(false)
		} catch {
			// Working tree diff failed
		}
	}

	const trimmed = diff ? diff.trim() : ""
	return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Cleans the commit message output from LLM completions.
 */
export function cleanCommitMessage(message: string): string {
	let cleaned = message.trim()
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```[a-zA-Z]*\r?\n?/, "")
		cleaned = cleaned.replace(/\r?\n?```$/, "")
		cleaned = cleaned.trim()
	}
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		cleaned = cleaned.slice(1, -1).trim()
	}
	return cleaned
}

/**
 * Builds the full prompt to generate a commit message from a git diff.
 */
export function buildCommitMessagePrompt(diff: string): string {
	const truncatedDiff = truncateOutput(diff, 1000, 50000)
	return `${COMMIT_MESSAGE_SYSTEM_PROMPT}\n\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n\nCommit Message:`
}

/**
 * Generates a commit message using the active LLM provider and populates the SCM input box.
 */
export async function generateCommitMessage(options: GenerateCommitMessageOptions): Promise<void> {
	const { provider, outputChannel, context } = options

	try {
		const git = await getGitApi()
		if (!git) {
			vscode.window.showErrorMessage("Git extension not found or not enabled.")
			return
		}

		const repository = resolveGitRepository(git, context)
		if (!repository) {
			vscode.window.showErrorMessage("No Git repository found.")
			return
		}

		const diff = await getRepositoryDiff(repository)
		if (!diff) {
			vscode.window.showInformationMessage(
				"No staged or working directory changes found to generate commit message.",
			)
			return
		}

		const { apiConfiguration } = await provider.getState()
		if (!apiConfiguration || !apiConfiguration.apiProvider) {
			vscode.window.showErrorMessage(
				"No valid API provider configured. Please configure an API provider in Zoo Code settings.",
			)
			return
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Generating commit message...",
				cancellable: true,
			},
			async (_progress, token) => {
				const abortController = new AbortController()
				token.onCancellationRequested(() => {
					abortController.abort()
				})

				const prompt = buildCommitMessagePrompt(diff)
				const rawMessage = await singleCompletionHandler(apiConfiguration as ProviderSettings, prompt, {
					abortSignal: abortController.signal,
				})

				if (token.isCancellationRequested || abortController.signal.aborted) {
					return
				}

				const commitMessage = cleanCommitMessage(rawMessage)
				if (commitMessage) {
					repository.inputBox.value = commitMessage
				}
			},
		)
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
			return
		}
		const errorMessage = error instanceof Error ? error.message : String(error)
		outputChannel?.appendLine(`[generateGitCommitMessage] failed: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`)
	}
}
