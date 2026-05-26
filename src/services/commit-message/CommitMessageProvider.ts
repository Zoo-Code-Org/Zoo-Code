import * as path from "path"
import * as vscode from "vscode"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { t } from "../../i18n"
import { Package } from "../../shared/package"
import { GitChange, GitContextCollector } from "../git-context"

import { CommitMessageGenerator } from "./CommitMessageGenerator"
import { getCommitMessageGitContextSettings, toGitContextCollectorOptions } from "./gitContextSettings"

interface VscGenerationRequest {
	/** Source control input box that should receive the generated message. */
	inputBox: { value: string }
	/** Root URI supplied by VS Code for the source control command invocation. */
	rootUri?: vscode.Uri
}

/** Registers and handles the VS Code command that writes AI commit messages into SCM input. */
export class CommitMessageProvider implements vscode.Disposable {
	private generator: CommitMessageGenerator

	/** Creates the provider and wires it to the extension settings store. */
	constructor(
		private context: vscode.ExtensionContext,
		private outputChannel: vscode.OutputChannel,
	) {
		const providerSettingsManager = new ProviderSettingsManager(this.context)

		this.generator = new CommitMessageGenerator(providerSettingsManager)
	}

	/** Registers the generate commit message command with VS Code. */
	public async activate(): Promise<void> {
		this.outputChannel.appendLine(t("common:commitMessage.activated"))

		const disposables = [
			vscode.commands.registerCommand(
				`${Package.name}.generateCommitMessage`,
				(vsRequest?: VscGenerationRequest) => this.handleVSCodeCommand(vsRequest),
			),
		]
		this.context.subscriptions.push(...disposables)
	}

	/** Handles the command invocation from VS Code's SCM UI. */
	private async handleVSCodeCommand(vsRequest?: VscGenerationRequest): Promise<void> {
		try {
			const workspacePath = this.determineWorkspacePath(vsRequest?.rootUri)
			const targetRepository = await this.determineTargetRepository(workspacePath)
			if (!targetRepository?.rootUri) {
				throw new Error("Could not determine Git repository")
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.SourceControl,
					title: t("common:commitMessage.generating"),
					cancellable: false,
				},
				async (progress) => {
					let lastPercentage = 0
					const reportProgress = (percentage: number, message?: string) => {
						progress.report({
							increment: Math.max(0, percentage - lastPercentage),
							message: message || t("common:commitMessage.generating"),
						})
						lastPercentage = percentage
					}

					reportProgress(5, t("common:commitMessage.initializing"))
					const gitCollector = new GitContextCollector(workspacePath)

					try {
						reportProgress(15, t("common:commitMessage.discoveringFiles"))
						const resolution = await this.resolveCommitChanges(gitCollector)

						const gitContextSettings = getCommitMessageGitContextSettings()

						if (resolution.changes.length === 0) {
							vscode.window.showInformationMessage(t("common:commitMessage.noChanges"))
							return
						}
						reportProgress(25, t("common:commitMessage.foundChanges", { count: resolution.changes.length }))

						if (!resolution.usedStaged) {
							vscode.window.showInformationMessage(t("common:commitMessage.generatingFromUnstaged"))
						}

						reportProgress(40, t("common:commitMessage.gettingContext"))
						const gitContextResult = await gitCollector.collectContext(
							resolution.changes,
							toGitContextCollectorOptions(resolution.usedStaged, gitContextSettings),
							resolution.files,
						)
						if (gitContextResult.warnings.length > 0) {
							vscode.window.showWarningMessage(
								t("common:commitMessage.contextWarnings", {
									warnings: gitContextResult.warnings.join("; "),
								}),
							)
						}

						reportProgress(70, t("common:commitMessage.generating"))
						const gitContext = this.appendExistingCommitMessageDraft(
							gitContextResult.context,
							targetRepository.inputBox.value,
						)
						const message = await this.generator.generateMessage({
							workspacePath,
							selectedFiles: resolution.files,
							gitContext,
							onProgress: (update) => {
								if (update.percentage !== undefined) {
									reportProgress(70 + update.percentage * 0.25, update.message)
								}
							},
						})

						targetRepository.inputBox.value = message
						reportProgress(100, t("common:commitMessage.generated"))
					} finally {
						gitCollector.dispose()
					}
				},
			)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred"
			vscode.window.showErrorMessage(t("common:commitMessage.generationFailed", { errorMessage }))
		}
	}

	/** Resolves staged changes, asking before falling back to unstaged worktree changes. */
	private async resolveCommitChanges(gitCollector: GitContextCollector): Promise<{
		changes: GitChange[]
		files: string[]
		usedStaged: boolean
	}> {
		let changes = await gitCollector.gatherChanges({ staged: true })
		let usedStaged = true

		if (changes.length === 0) {
			const useUnstaged = await this.confirmUnstagedGeneration()
			if (!useUnstaged) {
				return {
					changes: [],
					files: [],
					usedStaged,
				}
			}

			changes = await gitCollector.gatherChanges({ staged: false })
			usedStaged = false
		}

		return {
			changes,
			files: changes.map((change) => change.filePath),
			usedStaged,
		}
	}

	/** Finds the Git repository that owns the requested workspace path. */
	private async determineTargetRepository(workspacePath: string): Promise<VscGenerationRequest | null> {
		try {
			const gitExtension = vscode.extensions.getExtension("vscode.git")
			if (!gitExtension) {
				return null
			}

			if (!gitExtension.isActive) {
				await gitExtension.activate()
			}

			const gitApi = gitExtension.exports.getAPI(1)
			if (!gitApi) {
				return null
			}

			const repositories = gitApi.repositories ?? []
			const matchingRepositories = repositories
				.filter((repo: VscGenerationRequest) =>
					repo.rootUri ? isPathWithinRepository(workspacePath, repo.rootUri.fsPath) : false,
				)
				.sort(
					(a: VscGenerationRequest, b: VscGenerationRequest) =>
						(b.rootUri?.fsPath.length ?? 0) - (a.rootUri?.fsPath.length ?? 0),
				)

			if (matchingRepositories.length > 0) {
				return matchingRepositories[0]
			}

			if (repositories.length === 1) {
				return repositories[0]
			}

			return null
		} catch (error) {
			return null
		}
	}

	/** Derives the workspace path from the SCM resource or active workspace. */
	private determineWorkspacePath(resourceUri?: vscode.Uri): string {
		if (resourceUri) {
			return resourceUri.fsPath
		}

		const workspaceFolders = vscode.workspace.workspaceFolders ?? []
		if (workspaceFolders.length === 1) {
			return workspaceFolders[0].uri.fsPath
		}

		if (workspaceFolders.length > 1) {
			throw new Error("Run this command from a specific Git source control input in a multi-root workspace")
		}

		throw new Error("Could not determine workspace path")
	}

	/** Adds an existing commit input draft to the model context so the next message can improve it. */
	private appendExistingCommitMessageDraft(gitContext: string, existingDraft: string): string {
		const normalizedDraft = existingDraft.trim()
		if (!normalizedDraft) {
			return gitContext
		}

		return `${gitContext}

## Existing Commit Message Draft
The Git commit input already contains this draft. Use it as guidance and generate the best final commit message for the changes. You may improve, replace, or preserve parts of it as appropriate.

\`\`\`
${normalizedDraft}
\`\`\``
	}

	/** Confirms whether unstaged changes may be gathered when there are no staged changes. */
	private async confirmUnstagedGeneration(): Promise<boolean> {
		const confirmAction = t("common:commitMessage.confirmUnstagedAction")
		const choice = await vscode.window.showWarningMessage(
			t("common:commitMessage.useUnstagedConfirm"),
			{ modal: true },
			confirmAction,
		)

		return choice === confirmAction
	}

	/** Keeps provider cleanup compatible with VS Code disposable registration. */
	public dispose(): void {}
}

/** Returns true when the target path is the repository root or is contained by it. */
export function isPathWithinRepository(targetPath: string, repositoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(repositoryPath), path.resolve(targetPath))
	return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}
