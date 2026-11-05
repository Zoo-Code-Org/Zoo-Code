import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type RooCodeAPI,
	type RooCodeSettings,
	type RooCodeEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	type TaskStartResponse,
	type CreateTaskOptions,
	type TaskApiConversationHistorySequence,
	type WebviewThemeFixture,
	RooCodeEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
	TASK_START_FAILURE_ERROR_CODE,
	TASK_START_FAILURE_ERROR_MESSAGE,
} from "@roo-code/types"

import { IpcServer } from "@roo-code/ipc"

import { Package } from "../shared/package"
import type { Mode } from "../shared/modes"
import type { ClineProvider } from "../core/webview/ClineProvider"
import type { ClineProviderFactory } from "../core/webview/ClineProviderFactory"
import { isNonPortableSettingsKey } from "../core/config/ContextProxy"
import { withoutInvalidDisplaySettings } from "../core/config/displaySettings"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { Terminal } from "../integrations/terminal/Terminal"
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry"
import { getCommands } from "../services/command/commands"

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ClineProvider
	private readonly ipc?: IpcServer
	private readonly log: (...args: unknown[]) => void
	private logfile?: string

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ClineProvider,
		private readonly providerFactory: ClineProviderFactory,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider

		if (enableLogging) {
			this.log = (...args: unknown[]) => {
				this.outputChannelLog(...args)
				console.log(args)
			}

			this.logfile = path.join(os.tmpdir(), "roo-code-messages.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners(this.sidebarProvider)

		if (socketPath) {
			const ipc = (this.ipc = new IpcServer(socketPath, this.log))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (clientId, command) => {
				const sendResponse = (eventName: RooCodeEventName, payload: unknown[]) => {
					ipc.send(clientId, {
						type: IpcMessageType.TaskEvent,
						origin: IpcOrigin.Server,
						data: { eventName, payload } as TaskEvent,
					})
				}

				switch (command.commandName) {
					case TaskCommandName.StartNewTask: {
						// Neither prompt nor settings values enter the log.
						this.log("[API] StartNewTask", {
							promptLength: command.data.text.length,
							imageCount: command.data.images?.length ?? 0,
							newTab: command.data.newTab === true,
							requestId: command.data.requestId,
						})

						const { requestId } = command.data

						if (requestId === undefined) {
							await this.startNewTask(command.data, { focusSidebar: false })
							break
						}

						// Exactly one sanitized, client-scoped response per
						// correlated start. The reply never echoes the failure.
						// Await actual startup, including configuration writes.
						// The smoke controller owns its timeout and terminates
						// its isolated host; shared-profile writes are not raced.
						let response: TaskStartResponse
						try {
							const taskId = await this.startNewTask(command.data, {
								focusSidebar: false,
							})
							response = { requestId, success: true, taskId }
						} catch {
							this.log("[API] StartNewTask failed", { requestId })
							response = {
								requestId,
								success: false,
								errorCode: TASK_START_FAILURE_ERROR_CODE,
								errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
							}
						}
						sendResponse(RooCodeEventName.TaskStartResponse, [response])
						break
					}
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask`)
						await this.cancelCurrentTask()
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
					case TaskCommandName.ResumeTask:
						this.log(`[API] ResumeTask -> ${command.data}`)
						try {
							await this.resumeTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ResumeTask failed for taskId ${command.data}: ${errorMessage}`)
							// Don't rethrow - we want to prevent IPC server crashes.
							// The error is logged for debugging purposes.
						}
						break
					case TaskCommandName.SendMessage:
						this.log(`[API] SendMessage -> ${command.data.text}`)
						await this.sendMessage(command.data.text, command.data.images)
						break
					case TaskCommandName.GetCommands:
						try {
							const commands = await getCommands(this.sidebarProvider.cwd)

							sendResponse(RooCodeEventName.CommandsResponse, [
								commands.map((cmd) => ({
									name: cmd.name,
									source: cmd.source,
									filePath: cmd.filePath,
									description: cmd.description,
									argumentHint: cmd.argumentHint,
								})),
							])
						} catch {
							sendResponse(RooCodeEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(RooCodeEventName.ModesResponse, [modes])
						} catch {
							sendResponse(RooCodeEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						} catch {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						}

						break
					case TaskCommandName.DeleteQueuedMessage:
						this.log(`[API] DeleteQueuedMessage -> ${command.data}`)
						try {
							this.deleteQueuedMessage(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] DeleteQueuedMessage failed for messageId ${command.data}: ${errorMessage}`)
						}
						break
				}
			})
		}
	}

	public override emit<K extends keyof RooCodeEvents>(
		eventName: K,
		...args: K extends keyof RooCodeEvents ? RooCodeEvents[K] : never
	) {
		const data = { eventName: eventName as RooCodeEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })
		return super.emit(eventName, ...args)
	}

	public async startNewTask(
		{
			configuration,
			text,
			images,
			newTab,
		}: {
			configuration: RooCodeSettings
			text?: string
			images?: string[]
			newTab?: boolean
		},
		startOptions?: { focusSidebar?: boolean },
	) {
		let provider: ClineProvider

		if (newTab) {
			await vscode.commands.executeCommand("workbench.action.files.revert")
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")

			provider = await this.providerFactory.createInNewTab()
			this.registerListeners(provider)
		} else {
			// IPC callers omit focus: executeCommand cannot be cancelled and a
			// stalled webview launch would block the whole start.
			if (startOptions?.focusSidebar ?? true) {
				await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			}

			provider = this.sidebarProvider
		}

		await provider.evictCurrentTask()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		// API-driven tasks never stop to ask the user, so the hard stop is
		// effectively unlimited. The soft repetition tier is disabled too:
		// without a reachable hard stop it would reject every identical call
		// with no escalation.
		const options: CreateTaskOptions = {
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
			toolRepetitionSoftLimit: 0,
		}

		const task = await provider.createTask(text, images, undefined, options, configuration)

		if (!task) {
			throw new Error("Failed to create task due to policy restrictions")
		}

		return task.taskId
	}

	public async resumeTask(taskId: string): Promise<void> {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		await this.waitForWebviewLaunch(5_000)

		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		await this.sidebarProvider.createTaskWithHistoryItem(historyItem)

		if (this.sidebarProvider.viewLaunched) {
			await this.sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		} else {
			this.log(
				`[API#resumeTask] webview not launched after resume for task ${taskId}; continuing in headless mode`,
			)
		}
	}

	public async isTaskInHistory(taskId: string): Promise<boolean> {
		try {
			await this.sidebarProvider.getTaskWithId(taskId)
			return true
		} catch {
			return false
		}
	}

	public async getTaskHistoryItem(taskId: string) {
		const item = this.sidebarProvider.taskHistoryStore.get(taskId)
		return item ? structuredClone(item) : undefined
	}

	public async getTaskApiConversationHistoryLength(taskId: string): Promise<number> {
		try {
			const { apiConversationHistory } = await this.sidebarProvider.getTaskWithId(taskId)
			return apiConversationHistory.length
		} catch {
			return 0
		}
	}

	/** Checks persisted turn ordering without exposing conversation contents to tests. */
	public async hasTaskApiConversationHistorySequence(
		taskId: string,
		sequence: TaskApiConversationHistorySequence,
	): Promise<boolean> {
		let apiConversationHistory: Awaited<ReturnType<ClineProvider["getTaskWithId"]>>["apiConversationHistory"]
		try {
			const task = await this.sidebarProvider.getTaskWithId(taskId)
			apiConversationHistory = task.apiConversationHistory
		} catch {
			return false
		}

		const userTurnIndex = apiConversationHistory.findIndex(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "text" && block.text.includes(sequence.userText)),
		)
		if (userTurnIndex < 0) return false

		// Search all assistant turns that belong to the same generation: between
		// this user turn and the next genuine user text turn (or end of history).
		// tool_result messages also use role:"user", so we must skip them —
		// stopping at a tool_result would cut the search short before a later
		// attempt_completion in the same generation.
		const nextUserIndex = apiConversationHistory.findIndex(
			(m, i) =>
				i > userTurnIndex &&
				m.role === "user" &&
				Array.isArray(m.content) &&
				m.content.some((block) => block.type === "text"),
		)
		const generationSlice = apiConversationHistory.slice(
			userTurnIndex + 1,
			nextUserIndex < 0 ? undefined : nextUserIndex,
		)
		return generationSlice.some(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(
					(block) =>
						block.type === "tool_use" &&
						block.name === sequence.assistantToolName &&
						JSON.stringify(block.input).includes(sequence.assistantToolInputText),
				),
		)
	}

	/** Checks persisted ui_messages.json contents without exposing messages to tests. */
	public async hasTaskUiMessageText(taskId: string, text: string): Promise<boolean> {
		let uiMessages: Awaited<ReturnType<typeof readTaskMessages>>
		try {
			// Reject unknown ids first: readTaskMessages creates the task directory.
			await this.sidebarProvider.getTaskWithId(taskId)
			uiMessages = await readTaskMessages({
				taskId,
				globalStoragePath: this.sidebarProvider.contextProxy.globalStorageUri.fsPath,
			})
		} catch {
			return false
		}
		return uiMessages.some((message) => message.text?.includes(text))
	}

	public getCurrentTaskStack() {
		return this.sidebarProvider.getCurrentTaskStack()
	}

	public async clearCurrentTask(_lastMessage?: string) {
		// Legacy finishSubTask removed; clear current by closing active task instance.
		await this.sidebarProvider.evictCurrentTask()
		await this.sidebarProvider.postStateToWebview()
	}

	public async cancelCurrentTask() {
		await this.sidebarProvider.cancelTask()
	}

	public async abandonSubtask(childTaskId: string): Promise<boolean> {
		return this.sidebarProvider.abandonSubtask(childTaskId)
	}

	public async sendMessage(text?: string, images?: string[]) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		// In headless/sandbox flows the webview may not be launched, so routing
		// through invoke=sendMessage drops the message. Deliver directly to the
		// task ask-response channel instead.
		if (!this.sidebarProvider.viewLaunched) {
			if (!currentTask) {
				this.log("[API#sendMessage] no current task in headless mode; message dropped")
				return
			}

			await currentTask.submitUserMessage(text ?? "", images)
			return
		}

		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public deleteQueuedMessage(messageId: string) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		if (!currentTask) {
			this.log(`[API#deleteQueuedMessage] no current task; ignoring delete for messageId ${messageId}`)
			return
		}

		currentTask.messageQueueService.removeMessage(messageId)
	}

	public async pressPrimaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	public async approveCurrentAsk() {
		this.sidebarProvider.getCurrentTask()?.approveAsk()
	}

	public isReady() {
		return this.sidebarProvider.viewLaunched
	}

	public captureWebviewThemeFixture(): Promise<WebviewThemeFixture> {
		return this.sidebarProvider.requestWebviewThemeFixture()
	}

	public getLatestAnnouncementId(): string {
		return this.sidebarProvider.latestAnnouncementId
	}

	private async waitForWebviewLaunch(timeoutMs: number): Promise<boolean> {
		try {
			await pWaitFor(() => this.sidebarProvider.viewLaunched, {
				timeout: timeoutMs,
				interval: 50,
			})

			return true
		} catch {
			this.log(`[API#waitForWebviewLaunch] webview did not launch within ${timeoutMs}ms`)
			return false
		}
	}

	private registerListeners(provider: ClineProvider) {
		provider.on(RooCodeEventName.TaskCompleted, async (taskId, tokenUsage, toolUsage) => {
			const historyItem = provider.taskHistoryStore.get(taskId)
			this.emit(RooCodeEventName.TaskCompleted, taskId, tokenUsage, toolUsage, {
				isSubtask: !!historyItem?.parentTaskId,
			})

			await this.fileLog(
				`[${new Date().toISOString()}] taskCompleted -> ${taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
			)
		})

		provider.on(RooCodeEventName.TaskCreated, (task) => {
			// Task Lifecycle

			task.on(RooCodeEventName.TaskStarted, async () => {
				this.emit(RooCodeEventName.TaskStarted, task.taskId)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${task.taskId}\n`)
			})

			task.on(RooCodeEventName.TaskAborted, () => {
				this.emit(RooCodeEventName.TaskAborted, task.taskId)
			})

			task.on(RooCodeEventName.TaskFocused, () => {
				this.emit(RooCodeEventName.TaskFocused, task.taskId)
			})

			task.on(RooCodeEventName.TaskUnfocused, () => {
				this.emit(RooCodeEventName.TaskUnfocused, task.taskId)
			})

			task.on(RooCodeEventName.TaskActive, () => {
				this.emit(RooCodeEventName.TaskActive, task.taskId)
			})

			task.on(RooCodeEventName.TaskInteractive, () => {
				this.emit(RooCodeEventName.TaskInteractive, task.taskId)
			})

			task.on(RooCodeEventName.TaskResumable, () => {
				this.emit(RooCodeEventName.TaskResumable, task.taskId)
			})

			task.on(RooCodeEventName.TaskIdle, () => {
				this.emit(RooCodeEventName.TaskIdle, task.taskId)
			})

			// Subtask Lifecycle

			task.on(RooCodeEventName.TaskPaused, () => {
				this.emit(RooCodeEventName.TaskPaused, task.taskId)
			})

			task.on(RooCodeEventName.TaskUnpaused, () => {
				this.emit(RooCodeEventName.TaskUnpaused, task.taskId)
			})

			task.on(RooCodeEventName.TaskSpawned, (childTaskId) => {
				this.emit(RooCodeEventName.TaskSpawned, task.taskId, childTaskId)
			})

			task.on(RooCodeEventName.TaskDelegated, (childTaskId: string) => {
				this.emit(RooCodeEventName.TaskDelegated, task.taskId, childTaskId)
			})

			task.on(RooCodeEventName.TaskDelegationCompleted, (childTaskId: string, summary: string) => {
				this.emit(RooCodeEventName.TaskDelegationCompleted, task.taskId, childTaskId, summary)
			})

			task.on(RooCodeEventName.TaskDelegationResumed, (childTaskId: string) => {
				this.emit(RooCodeEventName.TaskDelegationResumed, task.taskId, childTaskId)
			})

			// Task Execution

			task.on(RooCodeEventName.Message, async (message) => {
				this.emit(RooCodeEventName.Message, { taskId: task.taskId, ...message })

				if (message.message.partial !== true) {
					await this.fileLog(`[${new Date().toISOString()}] ${JSON.stringify(message.message, null, 2)}\n`)
				}
			})

			task.on(RooCodeEventName.TaskModeSwitched, (taskId, mode) => {
				this.emit(RooCodeEventName.TaskModeSwitched, taskId, mode)
			})

			task.on(RooCodeEventName.TaskAskResponded, () => {
				this.emit(RooCodeEventName.TaskAskResponded, task.taskId)
			})

			task.on(RooCodeEventName.QueuedMessagesUpdated, (taskId, messages) => {
				this.emit(RooCodeEventName.QueuedMessagesUpdated, taskId, messages)
			})

			// Task Analytics

			task.on(RooCodeEventName.TaskToolFailed, (taskId, tool, error) => {
				this.emit(RooCodeEventName.TaskToolFailed, taskId, tool, error)
			})

			task.on(RooCodeEventName.TaskTokenUsageUpdated, (_, tokenUsage, toolUsage) => {
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, task.taskId, tokenUsage, toolUsage)
			})

			// Let's go!

			this.emit(RooCodeEventName.TaskCreated, task.taskId)
		})

		// Delegation events are emitted by the provider, not by individual task instances.
		provider.on(RooCodeEventName.TaskDelegated, (parentTaskId, childTaskId) => {
			this.emit(RooCodeEventName.TaskDelegated, parentTaskId, childTaskId)
		})
		provider.on(RooCodeEventName.TaskDelegationCompleted, (parentTaskId, childTaskId, summary) => {
			this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, summary)
		})
		provider.on(RooCodeEventName.TaskDelegationResumed, (parentTaskId, childTaskId) => {
			this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		})
	}

	// Logging

	private outputChannelLog(...args: unknown[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(_key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): RooCodeSettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	/**
	 * Stores the settings, then the API profile and the mode profiles. The settings are written with
	 * `ContextProxy.setValues`, which is not a transaction (see there): if a setting cannot be stored,
	 * this rejects with a `SettingsWriteError` that lists the keys that were stored and the keys that
	 * were not (the cache of the failed keys has been read back from storage), the stored settings
	 * stay, and nothing after the settings is written. Invalid values of the display settings are
	 * dropped and logged first.
	 *
	 * The profile writes that follow the settings are wrapped by this unit. The existence check, the
	 * prior-record read and the save run inside the manager cross-instance critical section, while the
	 * prior mode-mapping read runs just before that section so a failed read aborts the call with
	 * nothing mutated, and the
	 * compensation runs in its own section after re-reading the record, so a record another view
	 * created is never deleted by this call rollback. On failure the call restores the prior record,
	 * the prior shared settings, the prior shared mode and profile pin, and the prior mapping of every
	 * mode the payload touched, then replays only the settings keys this call itself wrote, taken from
	 * the snapshot it captured; the original error is rethrown.
	 */
	public async setConfiguration(allValues: RooCodeSettings) {
		const values = withoutInvalidDisplaySettings(allValues, (key) =>
			this.sidebarProvider.log(`[setConfiguration] Ignored an invalid value for ${key}`),
		)
		// Derive the saved profile name once so the sibling refresh and the save
		// agree on the empty-string fallback.
		const savedProfileName = values.currentApiConfigName || "default"
		const manager = this.sidebarProvider.providerSettingsManager
		// The payload may carry machine-local state this call does not own (the host-owned viewStates
		// map above all): the forward write and the rollback below both filter it out, using the same
		// list the export schema and the import path consult (NON_PORTABLE_SETTINGS_KEYS).
		const forwardValues: RooCodeSettings = Object.fromEntries(
			Object.entries(values).filter(([key]) => !isNonPortableSettingsKey(key)),
		)
		// The getter map carries viewStates: a snapshot of every view selection as of now. The rollback
		// below replays the snapshot through setValues, which would pin every other view back to where
		// this call found them, so the host-owned key is dropped here as well.
		const snapshotValues: RooCodeSettings = Object.fromEntries(
			Object.entries(this.getConfiguration()).filter(([key]) => !isNonPortableSettingsKey(key)),
		)
		const previousSharedSettings = this.sidebarProvider.contextProxy.getProviderSettings()
		// getConfiguration() folds this view overlay into the merged copy, so its mode and profile pin
		// are this view values rather than the shared ones. Snapshot the shared pair here: the rollback
		// below replays the merged copy through setValues, which writes both keys to shared global
		// state, and without this snapshot a failed call would leave every other unpinned view on this
		// view mode and profile.
		const previousSharedMode = this.sidebarProvider.contextProxy.getValue("mode")
		const previousSharedProfileName = this.sidebarProvider.contextProxy.getValue("currentApiConfigName")
		// Capture the prior mapping of every mode this payload touches, so a partial mode fan-out rolls
		// back completely - including mappings this call creates for the first time (an undefined prior
		// id restores the no-mapping semantics getModeConfigId reports) - and so that this read joins the
		// fail-closed reads below: a rejection here aborts the call before the profile record is created
		// or overwritten, which is the state the compensation cannot reconstruct. Held outside the
		// critical section on purpose - it lengthens no cross-instance hold, and the mode writes it
		// guards happen after the section anyway.
		const previousModeConfigs: Array<[Mode, string | undefined]> = []
		if (values.modeApiConfigs) {
			for (const mode of Object.keys(values.modeApiConfigs)) {
				previousModeConfigs.push([mode as Mode, await manager.getModeConfigId(mode as Mode)])
			}
		}

		// The existence check, the prior-record read and the save run as one critical section of the
		// manager cross-instance lock - the same lock the profile rename, the persist path and the
		// handler deletions already join. Left unserialised the sequence is: we read the name as absent,
		// another view creates it through a locked writer, one of our own writes fails, and our rollback
		// deletes that view record together with its secrets. Nothing inside this section joins the
		// queue again: hasConfig, getProfile and saveConfig take only the per-instance lock, which is
		// the inner one, so the section cannot deadlock against itself.
		// Existence comes from the store rather than the cached profile list: a stale list could hide an
		// existing record and let rollback delete it. A failed existence read is treated as "may exist"
		// so rollback never deletes blindly, and the prior-record read still fails closed before
		// anything is mutated.
		const { recordExisted, previousRecord, savedId } = await manager.runExclusiveAcrossInstances(async () => {
			let existed: boolean
			try {
				existed = await manager.hasConfig(savedProfileName)
			} catch {
				existed = true
			}
			const priorRecord = existed ? await manager.getProfile({ name: savedProfileName }) : undefined
			// saveConfig validates before storing, so a rejected save leaves every domain
			// untouched and the call fails with nothing to roll back.
			const id = await manager.saveConfig(savedProfileName, values)
			return { recordExisted: existed, previousRecord: priorRecord, savedId: id }
		})
		try {
			await this.sidebarProvider.setValues(
				// Only the keys this call owns travel forward; see the filter comment above.
				forwardValues,
				{ savedProfileName },
			)
			if (values.modeApiConfigs) {
				await Promise.all(
					Object.entries(values.modeApiConfigs).map(([mode, configId]) =>
						manager.setModeConfig(mode as Mode, configId),
					),
				)
			}
		} catch (error) {
			// The save landed: roll back every domain this mutation touched - the
			// profile record, the sibling overlays pinned to it, the complete
			// settings round trip (global values, view-local state, and sibling
			// overlays), the shared provider settings, and the mode mappings.
			// Each restore is independent and logged; the original failure is
			// what the caller sees.
			let previousSettings: ProviderSettings | undefined
			if (previousRecord) {
				const { name: _previousName, id: _previousId, ...rest } = previousRecord
				previousSettings = rest
			}
			try {
				await manager.runExclusiveAcrossInstances(async () => {
					if (recordExisted && previousSettings) {
						await manager.saveConfig(savedProfileName, previousSettings)
						return
					}
					// This call created the name. A locked writer may have replaced the record between the
					// section above and this one, so re-read before deleting: only the record our own save
					// wrote is ours to remove, and the id that save returned identifies it.
					if (!(await manager.hasConfig(savedProfileName))) {
						return
					}
					const currentRecord = await manager.getProfile({ name: savedProfileName })
					if (currentRecord.id !== savedId) {
						this.log(
							`[setConfiguration] kept the profile record '${savedProfileName}': another view wrote ` +
								`it (id '${currentRecord.id}', this call wrote '${savedId}').`,
						)
						return
					}
					await manager.deleteConfig(savedProfileName)
				})
			} catch (restoreError) {
				this.log(
					`[setConfiguration] failed to restore the profile record '${savedProfileName}': ` +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			// A rollback may restore only what this call wrote, taken from the snapshot it captured.
			// Anything else the snapshot happens to hold belongs to a writer that has moved on since
			// then, so replaying it would roll another view change back into this one. That subsumes the
			// host-owned viewStates map and the pass-through taskHistory key: neither is replayed unless
			// this call own payload carried it.
			const writtenKeys = new Set(Object.keys(forwardValues))
			const replayValues: RooCodeSettings = Object.fromEntries(
				Object.entries(snapshotValues).filter(([key]) => writtenKeys.has(key)),
			)
			const previousProfileName = replayValues.currentApiConfigName || "default"
			try {
				await this.sidebarProvider.setValues(replayValues, { savedProfileName: previousProfileName })
			} catch (restoreError) {
				this.log(
					"[setConfiguration] failed to restore the previous configuration values: " +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			// The merged replay above wrote this view's mode and pin into shared state, which
			// belongs to every unpinned view: put the shared pair back from the pre-write snapshot.
			// This touches the shared store only - this view's own overlay keeps the same pair the
			// replay just wrote there, so nothing about this view changes.
			try {
				await this.sidebarProvider.contextProxy.setValues({
					mode: previousSharedMode,
					currentApiConfigName: previousSharedProfileName,
				})
			} catch (restoreError) {
				this.log(
					"[setConfiguration] failed to restore the shared mode and profile pin: " +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			// Replay the restored record to the sibling overlays pinned to the
			// saved profile AFTER the configuration restore: when the saved profile
			// is also the active profile, the restore above refreshes the same
			// siblings with non-secret values, and this replay must be the last
			// refresh so the overlays end on the restored record's settings. An
			// absent prior profile restores an empty overlay.
			try {
				await this.sidebarProvider.refreshViewLocalStateForUpdatedProfile(
					savedProfileName,
					previousSettings ?? {},
				)
			} catch (restoreError) {
				this.log(
					"[setConfiguration] failed to refresh the overlays pinned to '" +
						savedProfileName +
						"': " +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			// When the mutation switched profiles, the configuration restore above
			// refreshed siblings pinned to the previous profile from non-secret
			// values; replay that profile's complete stored record so those
			// overlays keep their credentials. A previous profile that cannot be
			// read keeps the restore's non-secret refresh.
			if (previousProfileName !== savedProfileName) {
				try {
					const previousProfileRecord = await manager.getProfile({ name: previousProfileName })
					const { name: _ppName, id: _ppId, ...previousProfileSettings } = previousProfileRecord
					await this.sidebarProvider.refreshViewLocalStateForUpdatedProfile(
						previousProfileName,
						previousProfileSettings,
					)
				} catch (restoreError) {
					this.log(
						"[setConfiguration] failed to refresh the overlays pinned to '" +
							previousProfileName +
							"': " +
							(restoreError instanceof Error ? restoreError.message : String(restoreError)),
					)
				}
			}
			try {
				await this.sidebarProvider.contextProxy.setProviderSettings(previousSharedSettings)
			} catch (restoreError) {
				this.log(
					"[setConfiguration] failed to restore the shared provider settings: " +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			try {
				await Promise.all(previousModeConfigs.map(([mode, configId]) => manager.setModeConfig(mode, configId)))
			} catch (restoreError) {
				this.log(
					"[setConfiguration] failed to restore the mode API config mappings: " +
						(restoreError instanceof Error ? restoreError.message : String(restoreError)),
				)
			}
			throw error
		}
		await this.sidebarProvider.postStateToWebview()
	}
	public setTerminalProfile(name: string | undefined): void {
		const previousProfile = Terminal.getTerminalProfile()
		Terminal.setTerminalProfile(name)

		if (Terminal.getTerminalProfile() !== previousProfile) {
			TerminalRegistry.closeIdleTerminals()
		}
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, activate)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}
}
