import * as vscode from "vscode"

import type {
	CreateRuleInput,
	DeleteRuleInput,
	RuleKind,
	RuleMetadata,
	RuleScope,
	WebviewMessage,
} from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"
import { openFile } from "../../integrations/misc/open-file"
import { createRule, deleteRule, getRules, getRulesDirectoryPath, resolveRuleFile } from "../../services/rules/rules"

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export async function handleRequestRules(provider: ClineProvider, cwd: string): Promise<RuleMetadata[]> {
	try {
		const modes = await provider.getModes()
		const rules = await getRules(cwd, { modes })
		await provider.postMessageToWebview({ type: "rules", rules })
		return rules
	} catch (error) {
		provider.log(`Error fetching rules: ${getErrorMessage(error)}`)
		await provider.postMessageToWebview({ type: "rules", rules: [] })
		return []
	}
}

export async function handleCreateRule(
	provider: ClineProvider,
	cwd: string,
	message: WebviewMessage,
): Promise<RuleMetadata[] | undefined> {
	try {
		const input = parseCreateRuleInput(message)
		const createdPath = await createRule(cwd, input)
		openFile(createdPath)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error creating rule: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to create rule: ${errorMessage}`)
		return undefined
	}

	try {
		return await refreshRules(provider, cwd)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Rule created but failed to refresh rules: ${errorMessage}`)
		vscode.window.showWarningMessage("Rule created, but refreshing the rules list failed.")
		return undefined
	}
}

export async function handleDeleteRule(
	provider: ClineProvider,
	cwd: string,
	message: WebviewMessage,
): Promise<RuleMetadata[] | undefined> {
	try {
		const input = parseDeleteRuleInput(message)
		await deleteRule(cwd, input)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error deleting rule: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to delete rule: ${errorMessage}`)
		return undefined
	}

	try {
		return await refreshRules(provider, cwd)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Rule deleted but failed to refresh rules: ${errorMessage}`)
		vscode.window.showWarningMessage("Rule deleted, but refreshing the rules list failed.")
		return undefined
	}
}

export async function handleOpenRuleFile(provider: ClineProvider, cwd: string, message: WebviewMessage): Promise<void> {
	try {
		const input = parseDeleteRuleInput(message)
		const filePath = await resolveRuleFile(cwd, input)
		if (!filePath) {
			throw new Error("Rule file not found")
		}

		openFile(filePath)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error opening rule file: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to open rule file: ${errorMessage}`)
	}
}

export async function handleOpenRulesDirectory(
	provider: ClineProvider,
	cwd: string,
	message: WebviewMessage,
): Promise<void> {
	try {
		const values = message.values ?? {}
		const directoryPath = getRulesDirectoryPath(cwd, {
			scope: values.scope,
			kind: values.kind,
			modeSlug: values.modeSlug,
		} as CreateRuleInput)
		openFile(directoryPath)
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error opening rules directory: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to open rules directory: ${errorMessage}`)
	}
}

async function refreshRules(provider: ClineProvider, cwd: string): Promise<RuleMetadata[]> {
	const modes = await provider.getModes()
	const rules = await getRules(cwd, { modes })
	await provider.postMessageToWebview({ type: "rules", rules })
	return rules
}

function parseCreateRuleInput(message: WebviewMessage): CreateRuleInput {
	const values = message.values ?? {}
	const scope = parseRuleScope(values.scope)
	const kind = parseRuleKind(values.kind)
	const fileName = values.fileName ?? message.text

	if (!scope || !kind || !fileName) {
		throw new Error("Missing required fields: scope, kind, or fileName")
	}

	return {
		scope,
		kind,
		modeSlug: typeof values.modeSlug === "string" ? values.modeSlug : undefined,
		fileName,
	}
}

function parseDeleteRuleInput(message: WebviewMessage): DeleteRuleInput {
	const values = message.values ?? {}
	const scope = parseRuleScope(values.scope)
	const kind = parseRuleKind(values.kind)
	const relativePath = values.relativePath ?? message.text

	if (!scope || !kind || !relativePath) {
		throw new Error("Missing required fields: scope, kind, or relativePath")
	}

	return {
		id: typeof values.id === "string" ? values.id : undefined,
		scope,
		kind,
		modeSlug: typeof values.modeSlug === "string" ? values.modeSlug : undefined,
		relativePath,
	}
}

function parseRuleScope(value: unknown): RuleScope | undefined {
	return value === "global" || value === "project" ? value : undefined
}

function parseRuleKind(value: unknown): RuleKind | undefined {
	return value === "generic" || value === "mode" ? value : undefined
}
