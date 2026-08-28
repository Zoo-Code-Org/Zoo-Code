import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type RooCodeAPI,
	type GlobalState,
	type RooCodeSettings,
	type RooCodeEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	type TaskLike,
	type CreateTaskOptions,
	type WebviewThemeFixture,
	RooCodeEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
} from "@roo-code/types"
import { IpcServer } from "@roo-code/ipc"

import { Package } from "../shared/package"
import { getAllModes, type Mode } from "../shared/modes"
import { ClineProvider } from "../core/webview/ClineProvider"
import type { Task } from "../core/task/Task"
import { Terminal } from "../integrations/terminal/Terminal"
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry"
import { openClineInNewTab } from "../activate/registerCommands"
import { getCommands } from "../services/command/commands"
import { getModels } from "../api/providers/fetchers/modelCache"

type TaskAskController = {
	approveAsk(): void
	handleWebviewAskResponse(response: "messageResponse", text?: string, images?: string[]): void
}

type RegisteredTask = {
	task: TaskAskController
	provider: ClineProvider
}

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly tasksById = new Map<string, RegisteredTask>()
	private readonly log: (...args: unknown[]) => void
	private logfile?: string

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ClineProvider,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

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
					case TaskCommandName.StartNewTask:
						this.log(
							`[API] StartNewTask -> ${command.data.text}, ${JSON.stringify(command.data.configuration)}`,
						)
						await this.startNewTask(command.data)
						break
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
						} catch (error) {
							sendResponse(RooCodeEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(RooCodeEventName.ModesResponse, [modes])
						} catch (error) {
							sendResponse(RooCodeEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						} catch (error) {
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

	public async startNewTask({
		configuration,
		text,
		images,
		newTab,
		preserveOpenTabs,
	}: {
		configuration: RooCodeSettings
		text?: string
		images?: string[]
		newTab?: boolean
		preserveOpenTabs?: boolean
	}) {
		let provider: ClineProvider

		if (newTab) {
			if (!preserveOpenTabs) {
				await vscode.commands.executeCommand("workbench.action.files.revert")
				await vscode.commands.executeCommand("workbench.action.closeAllEditors")
			}

			provider = await openClineInNewTab({ context: this.context, outputChannel: this.outputChannel })
			this.registerListeners(provider)
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		await provider.evictCurrentTask()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const options: CreateTaskOptions = {
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
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

	/**
	 * Approves the pending ask for a specific task by its ID.
	 *
	 * @returns Whether a registered task with the given ID was found and approved.
	 */
	public async approveTaskAsk(taskId: string): Promise<boolean> {
		const entry = this.tasksById.get(taskId)

		if (!entry) {
			return false
		}

		entry.task.approveAsk()
		return true
	}

	/**
	 * Answers a task's pending ask with a follow-up suggestion, optionally switching that
	 * task's provider to the suggestion's mode before responding.
	 *
	 * @returns Whether a registered task with the given ID was found and answered.
	 */
	public async selectTaskFollowupSuggestion({
		taskId,
		answer,
		mode,
	}: {
		taskId: string
		answer: string
		mode?: string
	}): Promise<boolean> {
		const entry = this.tasksById.get(taskId)

		if (!entry) {
			return false
		}

		if (mode) {
			try {
				const { customModes } = await entry.provider.getState()
				const isValidMode = getAllModes(customModes).some((modeConfig) => modeConfig.slug === mode)

				if (isValidMode) {
					// entry.task is the registered Task instance (TaskAskController narrows it
					// to the ask-response surface); pass it explicitly so the switch is scoped to
					// this task rather than the provider's currently focused task.
					await entry.provider.handleModeSwitch(mode, entry.task as Task)
				} else {
					this.log(`[API#selectTaskFollowupSuggestion] ignoring unknown mode "${mode}" for task ${taskId}`)
				}
			} catch (error) {
				// A failed mode switch must not swallow the follow-up answer: the task's
				// pending ask would otherwise stay unanswered.
				this.log(
					`[API#selectTaskFollowupSuggestion] mode switch failed for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		entry.task.handleWebviewAskResponse("messageResponse", answer)
		return true
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

	/**
	 * Removes a task's registration only if the registered entry still belongs to this
	 * task instance: a replaced instance reusing the same taskId must not be dropped by
	 * the previous instance's teardown events.
	 */
	private removeRegisteredTask(task: TaskLike): void {
		const entry = this.tasksById.get(task.taskId)

		// The stored controller is this exact instance (registered above with a cast to
		// the ask-response surface), so reference equality is the right identity check.
		if (entry?.task === (task as unknown as TaskAskController)) {
			this.tasksById.delete(task.taskId)
		}
	}

	private registerListeners(provider: ClineProvider) {
		provider.on(RooCodeEventName.TaskCreated, (task) => {
			this.tasksById.set(task.taskId, { task: task as unknown as TaskAskController, provider })

			// Task Lifecycle

			task.on(RooCodeEventName.TaskStarted, async () => {
				this.emit(RooCodeEventName.TaskStarted, task.taskId)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${task.taskId}\n`)
			})

			task.on(RooCodeEventName.TaskCompleted, async (_, tokenUsage, toolUsage) => {
				this.emit(RooCodeEventName.TaskCompleted, task.taskId, tokenUsage, toolUsage, {
					isSubtask: !!task.parentTaskId,
				})
				this.removeRegisteredTask(task)

				await this.fileLog(
					`[${new Date().toISOString()}] taskCompleted -> ${task.taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
				)
			})

			task.on(RooCodeEventName.TaskAborted, () => {
				this.emit(RooCodeEventName.TaskAborted, task.taskId)
				this.removeRegisteredTask(task)
			})

			task.on(RooCodeEventName.TaskFocused, () => {
				this.emit(RooCodeEventName.TaskFocused, task.taskId)
			})

			task.on(RooCodeEventName.TaskUnfocused, () => {
				this.emit(RooCodeEventName.TaskUnfocused, task.taskId)
				this.removeRegisteredTask(task)
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

			task.on(RooCodeEventName.TaskDelegated as any, (childTaskId: string) => {
				;(this.emit as any)(RooCodeEventName.TaskDelegated, task.taskId, childTaskId)
			})

			task.on(RooCodeEventName.TaskDelegationCompleted as any, (childTaskId: string, summary: string) => {
				;(this.emit as any)(RooCodeEventName.TaskDelegationCompleted, task.taskId, childTaskId, summary)
			})

			task.on(RooCodeEventName.TaskDelegationResumed as any, (childTaskId: string) => {
				;(this.emit as any)(RooCodeEventName.TaskDelegationResumed, task.taskId, childTaskId)
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
			;(this.emit as any)(RooCodeEventName.TaskDelegated, parentTaskId, childTaskId)
		})
		provider.on(RooCodeEventName.TaskDelegationCompleted, (parentTaskId, childTaskId, summary) => {
			;(this.emit as any)(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, summary)
		})
		provider.on(RooCodeEventName.TaskDelegationResumed, (parentTaskId, childTaskId) => {
			;(this.emit as any)(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
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
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
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
		// getValues() merges view-local state, whose apiConfiguration is a nested object that
		// can carry provider secrets (e.g. apiKey). Flatten the provider settings onto the top
		// level (the pre-existing flat shape) so the secret filter removes them before return.
		const values = this.sidebarProvider.getValues()
		const { apiConfiguration, ...rest } = values
		return Object.fromEntries(
			Object.entries({ ...rest, ...apiConfiguration }).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: RooCodeSettings) {
		await this.sidebarProvider.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		if (values.modeApiConfigs) {
			await Promise.all(
				Object.entries(values.modeApiConfigs).map(([mode, configId]) =>
					this.sidebarProvider.providerSettingsManager.setModeConfig(mode as Mode, configId),
				),
			)
		}
		await this.sidebarProvider.postStateToWebview()
	}

	public getGlobalState<K extends keyof GlobalState>(key: K): GlobalState[K] {
		return this.context.globalState.get<GlobalState[K]>(key)
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
