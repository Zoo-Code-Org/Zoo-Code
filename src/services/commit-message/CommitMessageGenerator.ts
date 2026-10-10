import { ContextProxy } from "../../core/config/ContextProxy"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { singleCompletionHandler as defaultSingleCompletionHandler } from "../../utils/single-completion-handler"
import { supportPrompt } from "../../shared/support-prompt"
import { addCustomInstructions as defaultAddCustomInstructions } from "../../core/prompts/sections/custom-instructions"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName, type ProviderSettings } from "@roo-code/types"

import { GenerateMessageParams, PromptOptions, ProgressUpdate } from "./types/core"

/** Provides the extension settings needed to generate commit messages. */
export interface CommitMessageContextProxy {
	/** Whether the underlying extension configuration is ready to read. */
	isInitialized: boolean
	/** Returns the active provider settings used as the default generation profile. */
	getProviderSettings(): ProviderSettings
	/** Reads a persisted extension setting by key. */
	getValue(key: any): unknown
}

/** Overrides used to isolate commit message generation in tests and integrations. */
export interface CommitMessageGeneratorDependencies {
	/** Supplies the context proxy that owns provider settings and user configuration. */
	getContextProxy?: () => CommitMessageContextProxy
	/** Completes the prepared commit-message prompt with the selected provider. */
	completePrompt?: (apiConfiguration: ProviderSettings, promptText: string) => Promise<string>
	/** Adds repository-specific custom instructions to the commit-message prompt. */
	addCustomInstructions?: typeof defaultAddCustomInstructions
	/** Records successful commit-message generation telemetry. */
	captureGenerated?: () => void
	/** Receives non-fatal generation warnings, such as profile fallback failures. */
	logger?: Pick<Console, "warn">
}

/** Builds prompts, selects provider settings, and extracts AI generated commit messages. */
export class CommitMessageGenerator {
	private readonly providerSettingsManager: ProviderSettingsManager
	private readonly dependencies: Required<CommitMessageGeneratorDependencies>
	private previousGitContext: string | null = null
	private previousCommitMessage: string | null = null

	/** Creates a generator using the provider settings manager and optional test seams. */
	constructor(
		providerSettingsManager: ProviderSettingsManager,
		dependencies: CommitMessageGeneratorDependencies = {},
	) {
		this.providerSettingsManager = providerSettingsManager
		this.dependencies = {
			getContextProxy: dependencies.getContextProxy ?? (() => ContextProxy.instance),
			completePrompt: dependencies.completePrompt ?? defaultSingleCompletionHandler,
			addCustomInstructions: dependencies.addCustomInstructions ?? defaultAddCustomInstructions,
			captureGenerated:
				dependencies.captureGenerated ??
				(() => TelemetryService.instance.captureEvent(TelemetryEventName.COMMIT_MSG_GENERATED)),
			logger: dependencies.logger ?? console,
		}
	}

	/** Generates a commit message for the supplied Git context. */
	async generateMessage(params: GenerateMessageParams): Promise<string> {
		const { gitContext, onProgress } = params

		try {
			this.validateGitContext(gitContext)

			onProgress?.({
				message: "Generating commit message...",
				percentage: 75,
			})

			const generatedMessage = await this.callAIForCommitMessage(gitContext, params.workspacePath, onProgress)

			this.previousGitContext = gitContext
			this.previousCommitMessage = generatedMessage

			this.dependencies.captureGenerated()

			onProgress?.({
				message: "Commit message generated successfully",
				percentage: 100,
			})

			return generatedMessage
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred"
			throw new Error(`Failed to generate commit message: ${errorMessage}`)
		}
	}

	/** Creates the final model prompt, including custom and regeneration instructions. */
	async buildPrompt(gitContext: string, options: PromptOptions, workspacePath: string): Promise<string> {
		const { customSupportPrompts = {}, previousContext, previousMessage } = options

		const customInstructions = await this.dependencies.addCustomInstructions("", "", workspacePath, "commit", {
			language: "en",
		})

		const shouldGenerateDifferentMessage =
			(previousContext === gitContext || this.previousGitContext === gitContext) &&
			(previousMessage !== null || this.previousCommitMessage !== null)

		const targetPreviousMessage = previousMessage || this.previousCommitMessage

		if (shouldGenerateDifferentMessage && targetPreviousMessage) {
			const differentMessagePrefix = `# CRITICAL INSTRUCTION: GENERATE A COMPLETELY DIFFERENT COMMIT MESSAGE
The user has requested a new commit message for the same changes.
The previous message was: "${targetPreviousMessage}"
YOU MUST create a message that is COMPLETELY DIFFERENT by:
- Using entirely different wording and phrasing
- Focusing on different aspects of the changes
- Using a different structure or format if appropriate
- Possibly using a different type or scope if justifiable
This is the MOST IMPORTANT requirement for this task.

`
			const baseTemplate = supportPrompt.get(customSupportPrompts, "COMMIT_MESSAGE")
			const modifiedTemplate =
				differentMessagePrefix +
				baseTemplate +
				`

FINAL REMINDER: Your message MUST be COMPLETELY DIFFERENT from the previous message: "${targetPreviousMessage}". This is a critical requirement.`

			return supportPrompt.create(
				"COMMIT_MESSAGE",
				{
					gitContext,
					customInstructions: customInstructions || "",
				},
				{
					...customSupportPrompts,
					COMMIT_MESSAGE: modifiedTemplate,
				},
			)
		} else {
			return supportPrompt.create(
				"COMMIT_MESSAGE",
				{
					gitContext,
					customInstructions: customInstructions || "",
				},
				customSupportPrompts,
			)
		}
	}

	/** Calls the configured AI provider and returns the cleaned commit message text. */
	private async callAIForCommitMessage(
		gitContextString: string,
		workspacePath: string,
		onProgress?: (progress: ProgressUpdate) => void,
	): Promise<string> {
		const contextProxy = this.dependencies.getContextProxy()
		if (!contextProxy.isInitialized) {
			throw new Error("ContextProxy not initialized. Please try again after the extension has fully loaded.")
		}
		const apiConfiguration = contextProxy.getProviderSettings()
		const commitMessageApiConfigId = contextProxy.getValue("commitMessageApiConfigId") as string | undefined
		const listApiConfigMeta = (contextProxy.getValue("listApiConfigMeta") || []) as Array<{ id: string }>
		const customSupportPrompts = (contextProxy.getValue("customSupportPrompts") || {}) as Record<
			string,
			string | undefined
		>

		let configToUse: ProviderSettings = apiConfiguration

		if (commitMessageApiConfigId && listApiConfigMeta.find(({ id }) => id === commitMessageApiConfigId)) {
			try {
				await this.providerSettingsManager.initialize()
				const { name: _, ...providerSettings } = await this.providerSettingsManager.getProfile({
					id: commitMessageApiConfigId,
				})

				if (providerSettings.apiProvider) {
					configToUse = providerSettings
				}
			} catch (error) {
				this.dependencies.logger.warn(
					`Failed to load commit message API profile ${commitMessageApiConfigId}; falling back to current API configuration`,
					error,
				)
			}
		}

		const filteredPrompts = Object.fromEntries(
			Object.entries(customSupportPrompts).filter(([_, value]) => value !== undefined),
		) as Record<string, string>

		const prompt = await this.buildPrompt(
			gitContextString,
			{ customSupportPrompts: filteredPrompts },
			workspacePath,
		)

		onProgress?.({
			message: "Calling AI service...",
			increment: 10,
		})

		const response = await this.dependencies.completePrompt(configToUse, prompt)

		onProgress?.({
			message: "Processing AI response...",
			increment: 10,
		})

		return this.extractCommitMessage(response)
	}

	/** Throws when there is no meaningful Git change data to describe. */
	private validateGitContext(gitContext: string): void {
		if (!this.hasGitChanges(gitContext)) {
			throw new Error("No changes to generate a commit message for")
		}
	}

	/** Detects whether collected Git context includes at least one changed file. */
	private hasGitChanges(gitContext: string): boolean {
		const normalizedContext = gitContext.trim()

		if (!normalizedContext || normalizedContext.includes("(No changes matched selection)")) {
			return false
		}

		return (
			/^diff --git /m.test(normalizedContext) ||
			/^Binary file /m.test(normalizedContext) ||
			/^(Added|Modified|Deleted|Renamed|Copied|Updated|Untracked|Unknown) \((staged|unstaged)\): .+$/m.test(
				normalizedContext,
			)
		)
	}

	/** Cleans formatting wrappers from an AI response without enforcing message style. */
	private extractCommitMessage(response: string): string {
		const cleaned = response.trim()
		const withoutCodeBlocks = cleaned.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "").replace(/\r?\n```$/, "")
		const withoutQuotes = withoutCodeBlocks.replace(/^["'`]|["'`]$/g, "")
		return withoutQuotes.trim()
	}
}
