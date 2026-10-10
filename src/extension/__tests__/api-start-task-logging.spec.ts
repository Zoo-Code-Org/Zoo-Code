import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import {
	TaskCommandName,
	RooCodeEventName,
	TASK_START_FAILURE_ERROR_CODE,
	TASK_START_FAILURE_ERROR_MESSAGE,
	taskStartResponseSchema,
	providerIdentifiers,
	type RooCodeSettings,
} from "@roo-code/types"

import { API } from "../api"
import { Package } from "../../shared/package"
import type { ClineProvider } from "../../core/webview/ClineProvider"

const { commandHandlers, sentMessages } = vi.hoisted(() => ({
	commandHandlers: [] as Array<(clientId: string, command: unknown) => Promise<void>>,
	sentMessages: [] as Array<{ clientId: string; message: unknown }>,
}))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {
		listen(): void {}
		on(_messageType: unknown, handler: (clientId: string, command: unknown) => Promise<void>): void {
			commandHandlers.push(handler)
		}
		send(clientId: string, message: unknown): void {
			sentMessages.push({ clientId, message })
		}
	},
}))

type SentTaskEvent = { data: { eventName: RooCodeEventName; payload: unknown[] } }

const sentTaskEvents = (): SentTaskEvent[] => sentMessages.map(({ message }) => message as SentTaskEvent)

const buildStartCommand = (overrides?: { requestId?: string; text?: string }) => ({
	commandName: TaskCommandName.StartNewTask,
	data: {
		configuration: {
			apiProvider: providerIdentifiers.openai,
			openAiApiKey: "opaque-solheim-secret-0123456789abcdef",
			openAiModelId: "qwen3.8-27b",
			openAiBaseUrl: "https://api.solheim.ai/v1",
			autoApprovalEnabled: true,
		} as RooCodeSettings,
		text: overrides?.text ?? "provider connectivity smoke",
		requestId: overrides?.requestId,
	},
})

function buildApi(createTaskImpl?: () => Promise<{ taskId: string }>, postStateToWebviewImpl?: () => Promise<void>) {
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
	const provider = {
		context: {},
		on: vi.fn(),
		contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
		providerSettingsManager: { saveConfig: vi.fn().mockResolvedValue("default"), setModeConfig: vi.fn() },
		postStateToWebview: postStateToWebviewImpl
			? vi.fn().mockImplementation(postStateToWebviewImpl)
			: vi.fn().mockResolvedValue(undefined),
		evictCurrentTask: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		createTask: createTaskImpl
			? vi.fn().mockImplementation(createTaskImpl)
			: vi.fn().mockResolvedValue({ taskId: "task-1" }),
	} as unknown as ClineProvider

	const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
	const api = new API(outputChannel, provider, "/tmp/final-smoke-test.sock", true)

	const collectLogs = () =>
		[
			...(outputChannel.appendLine as ReturnType<typeof vi.fn>).mock.calls.flat().map(String),
			...consoleSpy.mock.calls.flat().map((arg) => JSON.stringify(arg)),
		].join("\n")

	return { api, provider, executeCommand, collectLogs }
}

describe("API StartNewTask IPC", () => {
	afterEach(() => {
		commandHandlers.length = 0
		sentMessages.length = 0
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("never logs the API key, base URL, or prompt text from the StartNewTask command", async () => {
		const { collectLogs } = buildApi()

		const handler = commandHandlers.at(-1)
		expect(handler).toBeDefined()

		await handler!("client-1", buildStartCommand())

		const logged = collectLogs()

		expect(logged).not.toContain("opaque-solheim-secret-0123456789abcdef")
		expect(logged).not.toContain('"openAiApiKey":"')
		// Configuration is omitted entirely, even nominally non-secret fields.
		expect(logged).not.toContain("openAiModelId")
		expect(logged).not.toContain("qwen3.8-27b")
		expect(logged).not.toContain("openAiBaseUrl")
		expect(logged).not.toContain("openAiApiKey")
		// Prompt content is metadata only: length, never text.
		expect(logged).not.toContain("provider connectivity smoke")
		expect(logged).toContain("promptLength")
	})

	it("omits the sidebar focus for an IPC start, so an unresolved focus command cannot block it", async () => {
		const { executeCommand } = buildApi()

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand({ requestId: "req-legacy" }))

		expect(executeCommand).not.toHaveBeenCalledWith(`${Package.name}.SidebarProvider.focus`)
	})

	it("answers a correlated start with exactly one sanitized success response", async () => {
		buildApi()

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand({ requestId: "req-1" }))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0]?.clientId).toBe("client-1")
		const events = sentTaskEvents()
		expect(events[0]?.data.eventName).toBe(RooCodeEventName.TaskStartResponse)

		expect(taskStartResponseSchema.parse(events[0]?.data.payload[0])).toEqual({
			requestId: "req-1",
			success: true,
			taskId: "task-1",
		})
	})

	it("answers a failed correlated start with exactly one fixed safe failure response", async () => {
		const rawError = new Error(
			"openai rejected key opaque-solheim-secret-0123456789abcdef at https://api.solheim.ai/v1 for prompt review the pull request diff",
		)
		buildApi(() => Promise.reject(rawError))

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand({ requestId: "req-2" }))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0]?.clientId).toBe("client-1")
		const events = sentTaskEvents()
		expect(events[0]?.data.eventName).toBe(RooCodeEventName.TaskStartResponse)

		const parsed = taskStartResponseSchema.parse(events[0]?.data.payload[0])
		expect(parsed).toEqual({
			requestId: "req-2",
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
		})

		const sent = JSON.stringify(sentMessages)
		expect(sent).not.toContain("opaque-solheim-secret-0123456789abcdef")
		expect(sent).not.toContain("api.solheim.ai")
		expect(sent).not.toContain("review the pull request diff")
	})

	it("does not race pending configuration/startup against a timeout", async () => {
		vi.useFakeTimers()
		let finishCreation!: (task: { taskId: string }) => void
		const { provider } = buildApi(
			() =>
				new Promise((resolve) => {
					finishCreation = resolve
				}),
		)
		const running = commandHandlers.at(-1)!("client-1", buildStartCommand({ requestId: "req-pending" }))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(provider.createTask).toHaveBeenCalledTimes(1)
		expect(sentMessages).toHaveLength(0)
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		finishCreation({ taskId: "finished-task" })
		await running
		expect(taskStartResponseSchema.parse(sentTaskEvents()[0]?.data.payload[0])).toEqual({
			requestId: "req-pending",
			success: true,
			taskId: "finished-task",
		})
	})

	it("reports a delayed startup rejection only after it settles, without late task removal", async () => {
		vi.useFakeTimers()
		let rejectCreation!: (error: Error) => void
		const { provider } = buildApi(
			() =>
				new Promise((_resolve, reject) => {
					rejectCreation = reject
				}),
		)
		const running = commandHandlers.at(-1)!("client-1", buildStartCommand({ requestId: "req-reject" }))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(sentMessages).toHaveLength(0)
		rejectCreation(new Error("private startup error"))
		await running
		expect(taskStartResponseSchema.parse(sentTaskEvents()[0]?.data.payload[0])).toEqual({
			requestId: "req-reject",
			success: false,
			errorCode: TASK_START_FAILURE_ERROR_CODE,
			errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
		})
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
	})

	it("sends no start response for legacy IPC starts without requestId", async () => {
		const { executeCommand } = buildApi()

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand())

		expect(sentMessages).toHaveLength(0)
		expect(executeCommand).not.toHaveBeenCalledWith(`${Package.name}.SidebarProvider.focus`)
	})

	it("keeps the sidebar focus for direct API callers that do not opt out", async () => {
		const { api, executeCommand } = buildApi()

		await api.startNewTask({ configuration: {} as RooCodeSettings, text: "direct caller" })

		expect(executeCommand).toHaveBeenCalledWith(`${Package.name}.SidebarProvider.focus`)
	})
})
