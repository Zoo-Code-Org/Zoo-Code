import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import { type ModelInfo, githubCopilotLanguageModel, vscodeLlmBaselineModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { CONTEXT_WINDOW_EXCEEDED_STATUS } from "../../core/context/context-management/context-error-handling"

import { convertToVsCodeLmMessages } from "../transform/vscode-lm-format"

import { VsCodeLmHandler, containsImageBlock, getVsCodeLmModels } from "./vscode-lm"
import { getVsCodeLmModelInfo } from "./vscode-lm-capabilities"

/**
 * GitHub Copilot as an API provider.
 *
 * Copilot's models are contributed to VS Code by the Copilot extension, so requests still travel
 * through the VS Code Language Model API. What differs from the generic provider is that the models
 * are never interchangeable with a stub, their capabilities are reported by the host, and a request
 * that exceeds a model's window must fail in a way Zoo can recover from by condensing.
 */
export class GitHubCopilotHandler extends VsCodeLmHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			vsCodeLmModelSelector: { ...options.vsCodeLmModelSelector, vendor: githubCopilotLanguageModel.vendor },
		})
	}

	protected override createFallbackClient(): vscode.LanguageModelChat {
		throw new Error(
			"No matching GitHub Copilot model is available. Sign in to GitHub and enable the model in Copilot Chat.",
		)
	}

	protected override deriveModelInfo(client: vscode.LanguageModelChat): ModelInfo {
		return getVsCodeLmModelInfo(client)
	}

	protected override getFallbackModelInfo(): ModelInfo {
		return vscodeLlmBaselineModelInfo
	}

	protected override supportsImageInput(info: ModelInfo): boolean {
		return info.supportsImages === true
	}

	protected override prepareMessageForCounting(message: vscode.LanguageModelChatMessage) {
		// Image parts only count when the message reaches the counter intact.
		return message
	}

	protected override assertRequestSupported(messages: Anthropic.Messages.MessageParam[], info: ModelInfo): void {
		if (!info.supportsImages && messages.some((message) => containsImageBlock(message.content))) {
			throw new Error(
				"The selected Copilot model does not report image input support. Select a model that supports images, or remove the image.",
			)
		}
	}

	protected override assertWithinContextWindow(inputTokens: number, info: ModelInfo): void {
		if (inputTokens > info.contextWindow) {
			this.ensureCleanState()
			throw Object.assign(
				new Error(
					"The request exceeds the selected Copilot model's input context window. Condense the conversation or start a new task.",
				),
				{ status: CONTEXT_WINDOW_EXCEEDED_STATUS },
			)
		}
	}

	/** Copilot reports each model's usable input window, so the live value is authoritative. */
	override getCondenseContextWindow(): number {
		return this.getModel().info.contextWindow
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		await this.getClient()
		const info = this.getModel().info
		const messages = convertToVsCodeLmMessages([{ role: "user", content }], this.supportsImageInput(info))
		return this.calculateTotalInputTokens(messages)
	}
}

// Sign-in -----------------------------------------------------------------------------------------

function getGitHubSession(options: vscode.AuthenticationGetSessionOptions) {
	const { authProviderId, authScopeSets } = githubCopilotLanguageModel
	return authScopeSets.reduce<Promise<vscode.AuthenticationSession | undefined>>(
		async (found, scopes) => (await found) ?? vscode.authentication.getSession(authProviderId, scopes, options),
		Promise.resolve(undefined),
	)
}

type SignInResult = { account: string; models: Awaited<ReturnType<typeof getVsCodeLmModels>> }

// Keyed by whether a fresh session was requested, so a Reconnect is never answered by a plain sign-in.
const signInsInFlight = new Map<boolean, Promise<SignInResult>>()

/**
 * Signs in to GitHub and lists the Copilot models that become available. Concurrent calls with the
 * same `forceNewSession` share one attempt, so a double click cannot open two sign-in prompts.
 *
 * Authenticating does not prove a Copilot entitlement: an account without one signs in successfully
 * and simply sees no models, which callers must present as such.
 */
export function connectGitHubCopilot(onAuthenticated?: (account: string) => Promise<void>, forceNewSession = false) {
	const pending = signInsInFlight.get(forceNewSession)
	if (pending) return pending

	const attempt = (async (): Promise<SignInResult> => {
		try {
			const { authProviderId, authScopeSets, chatExtensionId, selector } = githubCopilotLanguageModel
			const session = await vscode.authentication.getSession(
				authProviderId,
				authScopeSets[0],
				forceNewSession ? { forceNewSession: true, clearSessionPreference: true } : { createIfNone: true },
			)
			if (!session) throw new Error("GitHub sign-in did not complete. Please try again.")
			await onAuthenticated?.(session.account.label)
			await vscode.extensions.getExtension(chatExtensionId)?.activate()
			return { account: session.account.label, models: await getVsCodeLmModels(selector) }
		} finally {
			signInsInFlight.delete(forceNewSession)
		}
	})()
	signInsInFlight.set(forceNewSession, attempt)
	return attempt
}

/** The signed-in account, or undefined when there is none or the lookup is not possible. */
export async function getGitHubCopilotAccount() {
	try {
		return (await getGitHubSession({ silent: true }))?.account.label
	} catch {
		return undefined
	}
}

/**
 * Opens VS Code's own account management, where the user can sign out. VS Code exposes no API to
 * sign out on an extension's behalf, so Zoo defers to the host's UI instead of reaching for internals.
 */
export function openGitHubAccountManagement() {
	return vscode.commands.executeCommand(githubCopilotLanguageModel.manageAccountsCommandId)
}
