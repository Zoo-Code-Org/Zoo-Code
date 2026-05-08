import * as vscode from "vscode"

import { type HistoryItem, type ProviderSettings, type ProviderSettingsEntry, getModelId } from "@roo-code/types"

import { Package } from "../../shared/package"
import { t } from "../../i18n"

import type { ContextProxy } from "../config/ContextProxy"
import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"

type ActiveTask = {
	taskId: string
	apiConfiguration: ProviderSettings
	setTaskApiConfigName(apiConfigName: string | undefined): void
	updateApiConfiguration(providerSettings: ProviderSettings): void
}

export interface ProviderProfileManagerOptions {
	contextProxy: ContextProxy
	getProviderSettingsManager: () => ProviderSettingsManager
	getCurrentTask: () => ActiveTask | undefined
	getState: () => Promise<{
		mode: string
		listApiConfigMeta?: ProviderSettingsEntry[]
		currentApiConfigName?: string
	}>
	getTaskHistoryItem: (taskId: string) => HistoryItem | undefined
	updateTaskHistory: (historyItem: HistoryItem) => Promise<unknown>
	postStateToWebview: () => Promise<void>
	log: (message: string) => void
	emitProviderProfileChanged: (config: { name: string; provider?: string }) => void
}

export class ProviderProfileManager {
	private readonly contextProxy: ContextProxy
	private readonly getProviderSettingsManager: () => ProviderSettingsManager
	private readonly getCurrentTask: () => ActiveTask | undefined
	private readonly getState: () => Promise<{
		mode: string
		listApiConfigMeta?: ProviderSettingsEntry[]
		currentApiConfigName?: string
	}>
	private readonly getTaskHistoryItem: (taskId: string) => HistoryItem | undefined
	private readonly updateTaskHistory: (historyItem: HistoryItem) => Promise<unknown>
	private readonly postStateToWebview: () => Promise<void>
	private readonly log: (message: string) => void
	private readonly emitProviderProfileChanged: (config: { name: string; provider?: string }) => void

	constructor({
		contextProxy,
		getProviderSettingsManager,
		getCurrentTask,
		getState,
		getTaskHistoryItem,
		updateTaskHistory,
		postStateToWebview,
		log,
		emitProviderProfileChanged,
	}: ProviderProfileManagerOptions) {
		this.contextProxy = contextProxy
		this.getProviderSettingsManager = getProviderSettingsManager
		this.getCurrentTask = getCurrentTask
		this.getState = getState
		this.getTaskHistoryItem = getTaskHistoryItem
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.log = log
		this.emitProviderProfileChanged = emitProviderProfileChanged
	}

	public getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	public getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	public async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			const id = await this.getProviderSettingsManager().saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.getState()

				await Promise.all([
					this.contextProxy.setValue(
						"listApiConfigMeta",
						await this.getProviderSettingsManager().listConfig(),
					),
					this.contextProxy.setValue("currentApiConfigName", name),
					this.getProviderSettingsManager().setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings),
				])

				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.contextProxy.setValue(
					"listApiConfigMeta",
					await this.getProviderSettingsManager().listConfig(),
				)
			}

			await this.postStateToWebview()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	public async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.getProviderSettingsManager().deleteConfig(profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebview()
	}

	public async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.getProviderSettingsManager().activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true

		await Promise.all([
			this.contextProxy.setValue("listApiConfigMeta", await this.getProviderSettingsManager().listConfig()),
			this.contextProxy.setValue("currentApiConfigName", name),
			this.contextProxy.setProviderSettings(providerSettings),
		])

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.getProviderSettingsManager().setModeConfig(mode, id)
		}

		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.postStateToWebview()

		if (providerSettings.apiProvider) {
			this.emitProviderProfileChanged({ name, provider: providerSettings.apiProvider })
		}
	}

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	public mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	public mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean } = {},
	): void {
		const task = this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			task.updateApiConfiguration(providerSettings)
		} else {
			task.apiConfiguration = providerSettings
		}
	}

	private async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			task.setTaskApiConfigName(apiConfigName)

			const taskHistoryItem = this.getTaskHistoryItem(task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

			const validWorkspaceCommands = Array.isArray(workspaceCommands)
				? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			return [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]
		} catch (error) {
			console.error(`Error merging ${commandType} commands:`, error)
			return []
		}
	}
}
