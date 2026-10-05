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

function withStageTimeoutOverride(ms: string): () => void {
	const previous = process.env.ROO_CODE_TASK_START_STAGE_TIMEOUT_MS
	process.env.ROO_CODE_TASK_START_STAGE_TIMEOUT_MS = ms
	return () => {
		if (previous === undefined) {
			delete process.env.ROO_CODE_TASK_START_STAGE_TIMEOUT_MS
		} else {
			process.env.ROO_CODE_TASK_START_STAGE_TIMEOUT_MS = previous
		}
	}
}

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
		const events = sentTaskEvents()
		expect(events[0]?.data.eventName).toBe(RooCodeEventName.TaskStartResponse)

		const parsed = taskStartResponseSchema.safeParse(events[0]?.data.payload[0])
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data).toEqual({ requestId: "req-1", success: true, taskId: "task-1" })
		}
	})

	it("answers a failed correlated start with exactly one fixed safe failure response", async () => {
		const rawError = new Error(
			"openai rejected key opaque-solheim-secret-0123456789abcdef at https://api.solheim.ai/v1 for prompt review the pull request diff",
		)
		buildApi(() => Promise.reject(rawError))

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand({ requestId: "req-2" }))

		expect(sentMessages).toHaveLength(1)
		const events = sentTaskEvents()
		expect(events[0]?.data.eventName).toBe(RooCodeEventName.TaskStartResponse)

		const parsed = taskStartResponseSchema.safeParse(events[0]?.data.payload[0])
		expect(parsed.success).toBe(true)
		if (parsed.success && !parsed.data.success) {
			expect(parsed.data.errorCode).toBe(TASK_START_FAILURE_ERROR_CODE)
			expect(parsed.data.errorMessage).toBe(TASK_START_FAILURE_ERROR_MESSAGE)
			expect(parsed.data.stage).toBe("unknown")
		}

		const sent = JSON.stringify(sentMessages)
		expect(sent).not.toContain("opaque-solheim-secret-0123456789abcdef")
		expect(sent).not.toContain("api.solheim.ai")
		expect(sent).not.toContain("review the pull request diff")
	})

	it("bounds a hung task creation stage and answers with exactly one sanitized stage failure", async () => {
		const restore = withStageTimeoutOverride("100")
		try {
			const { collectLogs } = buildApi(() => new Promise(() => {}))

			const handler = commandHandlers.at(-1)
			await handler!("client-1", buildStartCommand({ requestId: "req-timeout-task" }))

			expect(sentMessages).toHaveLength(1)
			const events = sentTaskEvents()
			expect(events[0]?.data.eventName).toBe(RooCodeEventName.TaskStartResponse)

			const parsed = taskStartResponseSchema.safeParse(events[0]?.data.payload[0])
			expect(parsed.success).toBe(true)
			if (parsed.success && !parsed.data.success) {
				expect(parsed.data).toEqual({
					requestId: "req-timeout-task",
					success: false,
					errorCode: TASK_START_FAILURE_ERROR_CODE,
					errorMessage: TASK_START_FAILURE_ERROR_MESSAGE,
					stage: "taskCreation",
				})
			}

			const logged = collectLogs()
			expect(logged).toContain("taskCreation")
			expect(logged).toContain("req-timeout-task")
			expect(logged).not.toContain("opaque-solheim-secret-0123456789abcdef")
		} finally {
			restore()
		}
	})

	it("removes a late task and refuses a retry until the timed-out creation settles", async () => {
		const restore = withStageTimeoutOverride("50")
		try {
			let finishCreation: (task: { taskId: string }) => void = () => {}
			const { provider } = buildApi(
				() =>
					new Promise((resolve) => {
						finishCreation = resolve
					}),
			)
			const handler = commandHandlers.at(-1)!

			await handler("client-1", buildStartCommand({ requestId: "req-first" }))
			await handler("client-1", buildStartCommand({ requestId: "req-retry" }))

			expect(provider.createTask).toHaveBeenCalledTimes(1)
			const retry = taskStartResponseSchema.parse(sentTaskEvents()[1]?.data.payload[0])
			expect(retry.success).toBe(false)

			finishCreation({ taskId: "late-task" })
			await vi.waitFor(() => expect(provider.removeClineFromStack).toHaveBeenCalledTimes(1))

			await handler("client-1", buildStartCommand({ requestId: "req-after" }))
			expect(provider.createTask).toHaveBeenCalledTimes(2)
		} finally {
			restore()
		}
	})

	it("bounds a hung settings stage and names it in the failure response", async () => {
		const restore = withStageTimeoutOverride("100")
		try {
			buildApi(undefined, () => new Promise(() => {}))

			const handler = commandHandlers.at(-1)
			await handler!("client-1", buildStartCommand({ requestId: "req-timeout-settings" }))

			expect(sentMessages).toHaveLength(1)
			const parsed = taskStartResponseSchema.safeParse(sentTaskEvents()[0]?.data.payload[0])
			expect(parsed.success).toBe(true)
			if (parsed.success && !parsed.data.success) {
				expect(parsed.data.stage).toBe("settings")
			}
		} finally {
			restore()
		}
	})

	it("still answers with one success response when every stage is fast under a small bound", async () => {
		const restore = withStageTimeoutOverride("100")
		try {
			buildApi()

			const handler = commandHandlers.at(-1)
			await handler!("client-1", buildStartCommand({ requestId: "req-fast" }))

			expect(sentMessages).toHaveLength(1)
			const parsed = taskStartResponseSchema.safeParse(sentTaskEvents()[0]?.data.payload[0])
			expect(parsed.success).toBe(true)
			if (parsed.success) {
				expect(parsed.data).toEqual({ requestId: "req-fast", success: true, taskId: "task-1" })
			}
		} finally {
			restore()
		}
	})

	it("sends no start response for legacy IPC starts without requestId", async () => {
		buildApi()

		const handler = commandHandlers.at(-1)
		await handler!("client-1", buildStartCommand())

		expect(sentMessages).toHaveLength(0)
	})

	it("keeps the sidebar focus for direct API callers that do not opt out", async () => {
		const { api, executeCommand } = buildApi()

		await api.startNewTask({ configuration: {} as RooCodeSettings, text: "direct caller" })

		expect(executeCommand).toHaveBeenCalledWith(`${Package.name}.SidebarProvider.focus`)
	})
})
