import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"

import { providerIdentifiers, RooCodeEventName } from "@roo-code/types"

import type { ZooRemoteControlClient } from "@roo-code/core"

import { ZooRemoteControlBridge } from "../ZooRemoteControlBridge"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue?: boolean) => defaultValue),
			update: vi.fn().mockResolvedValue(undefined),
		})),
		workspaceFolders: [{ uri: { fsPath: "/tmp/project" } }],
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	env: {
		sessionId: "test-session-id",
		appName: "Code",
	},
}))

vi.mock("../../zoo-code-auth", () => ({
	getCachedZooCodeToken: vi.fn(() => ""),
	getZooCodeBaseUrl: vi.fn(() => "https://www.zoocode.dev"),
}))

import * as vscode from "vscode"
import { getCachedZooCodeToken } from "../../zoo-code-auth"

describe("ZooRemoteControlBridge", () => {
	let api: EventEmitter & {
		sendMessage: ReturnType<typeof vi.fn>
		cancelCurrentTask: ReturnType<typeof vi.fn>
		resumeTask: ReturnType<typeof vi.fn>
		startNewTask: ReturnType<typeof vi.fn>
	}
	let provider: EventEmitter & {
		contextProxy: { getProviderSettings: ReturnType<typeof vi.fn> }
		getCurrentTask: ReturnType<typeof vi.fn>
		handleModeSwitch: ReturnType<typeof vi.fn>
	}
	let client: {
		postPresence: ReturnType<typeof vi.fn>
		postEvents: ReturnType<typeof vi.fn>
		postSnapshot: ReturnType<typeof vi.fn>
		getCommands: ReturnType<typeof vi.fn>
		ackCommand: ReturnType<typeof vi.fn>
	}
	let context: {
		globalState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
		secrets: { onDidChange: ReturnType<typeof vi.fn> }
	}
	let sessionActive = false

	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()

		sessionActive = false
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn((_key: string, defaultValue?: boolean) => defaultValue ?? false),
			update: vi.fn().mockResolvedValue(undefined),
		} as never)

		vi.mocked(getCachedZooCodeToken).mockReturnValue("")

		api = Object.assign(new EventEmitter(), {
			sendMessage: vi.fn().mockResolvedValue(undefined),
			cancelCurrentTask: vi.fn().mockResolvedValue(undefined),
			resumeTask: vi.fn().mockResolvedValue(undefined),
			startNewTask: vi.fn().mockResolvedValue("task-1"),
		})

		provider = Object.assign(new EventEmitter(), {
			contextProxy: {
				getProviderSettings: vi.fn(() => ({ apiProvider: providerIdentifiers.openrouter })),
			},
			getCurrentTask: vi.fn(() => undefined),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		client = {
			postPresence: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
			postEvents: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
			postSnapshot: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
			getCommands: vi.fn().mockResolvedValue({ ok: true, status: 200, body: { commands: [] } }),
			ackCommand: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
		}

		context = {
			globalState: {
				get: vi.fn((key: string) => {
					if (key === "zooRemoteControl.instanceId") return "instance-1"
					if (key === "zooRemoteControl.eventSeq") return 0
					if (key === "zooRemoteControl.sessionActive") return sessionActive
					return undefined
				}),
				update: vi.fn(async (key: string, value: unknown) => {
					if (key === "zooRemoteControl.sessionActive") {
						sessionActive = value === true
					}
				}),
			},
			secrets: {
				onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			},
		}
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function createBridge() {
		return new ZooRemoteControlBridge({
			api: api as never,
			provider: provider as never,
			context: context as never,
			client: client as unknown as ZooRemoteControlClient,
			now: () => Date.now(),
		})
	}

	it("stays inactive when remote control is disabled", async () => {
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)
		expect(client.postPresence).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("activates when opted in with an eligible Zoo session", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(true)
		expect(client.postPresence).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "instance-1",
				apiProvider: providerIdentifiers.zooGateway,
				online: true,
				workspacePath: "project",
			}),
		)
		const presence = client.postPresence.mock.calls[0]?.[0] as { workspacePath?: string }
		expect(presence.workspacePath).toBe("project")
		expect(presence.workspacePath).not.toMatch(/[/\\]/)
		bridge.dispose()
	})

	it("posts only the workspace folder basename, never an absolute path", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		;(vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders = [
			{ uri: { fsPath: "C:\\Users\\alice\\Desktop\\secret-client" } },
		]

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(client.postPresence).toHaveBeenCalledWith(
			expect.objectContaining({
				workspacePath: "secret-client",
			}),
		)
		const presence = client.postPresence.mock.calls[0]?.[0] as { workspacePath?: string }
		expect(presence.workspacePath).not.toMatch(/[/\\]|Users|alice/i)
		bridge.dispose()
		;(vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders = [
			{ uri: { fsPath: "/tmp/project" } },
		]
	})

	it("does not activate when the provider is not eligible", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.anthropic,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("executes a remote message command and acks success", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		client.getCommands.mockResolvedValue({
			ok: true,
			status: 200,
			body: {
				commands: [
					{
						commandId: "cmd-1",
						type: "message",
						payload: { text: "hello from remote" },
					},
				],
			},
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.sendMessage).toHaveBeenCalledWith("hello from remote", undefined)
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "cmd-1", status: "acked" })
		bridge.dispose()
	})

	it("backs off when the remote endpoints return 404", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		client.postPresence.mockResolvedValue({ ok: false, status: 404 })
		client.getCommands.mockResolvedValue({ ok: false, status: 404 })

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		client.postPresence.mockClear()
		await vi.advanceTimersByTimeAsync(15_000)
		// Still in 404 backoff window â€” presence should not fire again yet.
		expect(client.postPresence).not.toHaveBeenCalled()

		bridge.dispose()
	})

	it("publishes non-partial message events while active", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		api.emit(RooCodeEventName.Message, {
			taskId: "task-1",
			action: "created",
			message: { ts: 1, type: "say", say: "text", text: "hi", partial: false },
		})

		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					taskId: "task-1",
					message: expect.objectContaining({ text: "hi" }),
				}),
			]),
		)
		bridge.dispose()
	})

	it("deactivates when the session is no longer eligible", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.openrouter,
		})
		provider.emit(RooCodeEventName.ProviderProfileChanged, {
			name: "OpenRouter",
			provider: providerIdentifiers.openrouter,
		})
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	async function activateEligibleBridge() {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)
		return bridge
	}

	it("approves and denies asks on the current task", async () => {
		const task = {
			taskId: "task-1",
			hasPendingAsk: vi.fn(() => true),
			approveAsk: vi.fn(),
			denyAsk: vi.fn(),
		}
		provider.getCurrentTask.mockReturnValue(task)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "a1", type: "approve_ask", payload: { text: "ok" } },
					{ commandId: "d1", type: "deny_ask", payload: { text: "no" } },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(task.approveAsk).toHaveBeenCalledWith({ text: "ok", images: undefined })
		expect(task.denyAsk).toHaveBeenCalledWith({ text: "no", images: undefined })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "a1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "d1", status: "acked" })
		bridge.dispose()
	})

	it("fails ask commands when there is no current task", async () => {
		provider.getCurrentTask.mockReturnValue(undefined)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "a1", type: "approve_ask" },
					{ commandId: "d1", type: "deny_ask" },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "a1",
			status: "failed",
			errorCode: "no_current_task",
		})
		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "d1",
			status: "failed",
			errorCode: "no_current_task",
		})
		bridge.dispose()
	})

	it("rejects commands when eligibility is lost mid-flight", async () => {
		client.getCommands.mockImplementation(async () => {
			provider.contextProxy.getProviderSettings.mockReturnValue({
				apiProvider: providerIdentifiers.openrouter,
			})
			return {
				ok: true,
				status: 200,
				body: { commands: [{ commandId: "m1", type: "message", payload: { text: "late" } }] },
			}
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "m1",
			status: "failed",
			errorCode: "not_eligible",
		})
		bridge.dispose()
	})

	it("cancels, resumes, starts, and switches mode from remote commands", async () => {
		provider.handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "c1", type: "cancel_task" },
					{ commandId: "r1", type: "resume_task", taskId: "task-9" },
					{ commandId: "s1", type: "start_task", payload: { text: "new work" } },
					{ commandId: "m1", type: "switch_mode", payload: { mode: "code" } },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.cancelCurrentTask).toHaveBeenCalled()
		expect(api.resumeTask).toHaveBeenCalledWith("task-9")
		expect(api.startNewTask).toHaveBeenCalledWith({ text: "new work", images: undefined })
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("code")
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "r1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "s1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "m1", status: "acked" })
		bridge.dispose()
	})

	it("fails resume_task when taskId is missing", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: { commands: [{ commandId: "r1", type: "resume_task" }] },
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "r1",
			status: "failed",
			errorCode: "missing_task_id",
		})
		bridge.dispose()
	})

	it("acks duplicate start_task commandIds without starting another task", async () => {
		client.getCommands
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: {
					commands: [{ commandId: "dup-start", type: "start_task", payload: { text: "first" } }],
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: {
					commands: [{ commandId: "dup-start", type: "start_task", payload: { text: "again" } }],
				},
			})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.startNewTask).toHaveBeenCalledTimes(1)
		expect(api.startNewTask).toHaveBeenCalledWith({ text: "first", images: undefined })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "dup-start", status: "acked" })
		bridge.dispose()
	})

	it("acks execution_failed when a command throws", async () => {
		api.sendMessage.mockRejectedValueOnce(new Error("boom"))
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: { commands: [{ commandId: "m1", type: "message", payload: { text: "x" } }] },
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "m1",
			status: "failed",
			errorCode: "execution_failed",
			message: "boom",
		})
		bridge.dispose()
	})

	it("emits lifecycle events while active", async () => {
		const bridge = await activateEligibleBridge()

		api.emit(RooCodeEventName.TaskInteractive, "task-1")
		api.emit(RooCodeEventName.TaskIdle, "task-1")
		api.emit(RooCodeEventName.TaskResumable, "task-1")
		api.emit(RooCodeEventName.TaskCompleted, "task-1")
		api.emit(RooCodeEventName.TaskAborted, "task-1")
		api.emit(RooCodeEventName.TaskModeSwitched, "task-1", "code")

		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([
				expect.objectContaining({ type: "task_interactive", taskId: "task-1" }),
				expect.objectContaining({ type: "task_idle", taskId: "task-1" }),
				expect.objectContaining({ type: "task_resumable", taskId: "task-1" }),
				expect.objectContaining({ type: "task_completed", taskId: "task-1" }),
				expect.objectContaining({ type: "task_aborted", taskId: "task-1" }),
				expect.objectContaining({ type: "mode_switched", taskId: "task-1", mode: "code" }),
			]),
		)
		bridge.dispose()
	})

	it("re-queues event batches when postEvents fails non-404", async () => {
		client.postEvents.mockResolvedValue({ ok: false, status: 500 })
		const bridge = await activateEligibleBridge()

		api.emit(RooCodeEventName.TaskIdle, "task-1")
		await vi.advanceTimersByTimeAsync(100)
		expect(client.postEvents).toHaveBeenCalled()

		client.postEvents.mockClear()
		client.postEvents.mockResolvedValue({ ok: true, status: 200 })
		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([expect.objectContaining({ type: "task_idle", taskId: "task-1" })]),
		)
		bridge.dispose()
	})

	it("ignores command poll responses that are not ok", async () => {
		client.getCommands.mockResolvedValue({ ok: false, status: 500 })
		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.ackCommand).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("sends message commands to the local API", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [{ commandId: "m1", type: "message", payload: { text: "hello", images: ["img"] } }],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.sendMessage).toHaveBeenCalledWith("hello", ["img"])
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "m1", status: "acked" })
		bridge.dispose()
	})

	it("answers follow-ups and can switch mode from the payload", async () => {
		provider.handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{
						commandId: "f1",
						type: "answer_followup",
						payload: { text: "option a", mode: "architect" },
					},
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.sendMessage).toHaveBeenCalledWith("option a", undefined)
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect")
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "f1", status: "acked" })
		bridge.dispose()
	})

	it("fails switch_mode when mode is missing", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: { commands: [{ commandId: "m1", type: "switch_mode", payload: {} }] },
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "m1",
			status: "failed",
			errorCode: "missing_mode",
		})
		bridge.dispose()
	})

	it("deactivates on auth/billing presence failures", async () => {
		const bridge = await activateEligibleBridge()
		client.postPresence.mockResolvedValueOnce({ ok: false, status: 401 })
		await vi.advanceTimersByTimeAsync(15_000)
		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("marks the bridge unavailable on command 404 and recovers after backoff", async () => {
		const bridge = await activateEligibleBridge()
		client.getCommands.mockResolvedValueOnce({ ok: false, status: 404 })
		await vi.advanceTimersByTimeAsync(2_000)

		client.getCommands.mockClear()
		client.postPresence.mockClear()
		await vi.advanceTimersByTimeAsync(15_000)
		expect(client.postPresence).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(50_000)
		client.postPresence.mockResolvedValue({ ok: true, status: 200 })
		client.getCommands.mockResolvedValue({ ok: true, status: 200, body: { commands: [] } })
		await vi.advanceTimersByTimeAsync(15_000)
		expect(client.postPresence).toHaveBeenCalled()
		bridge.dispose()
	})

	it("deactivates when command polling returns 403", async () => {
		const bridge = await activateEligibleBridge()
		client.getCommands.mockResolvedValueOnce({ ok: false, status: 403 })
		await vi.advanceTimersByTimeAsync(2_000)
		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("publishes a snapshot when the current task has messages", async () => {
		provider.getCurrentTask.mockReturnValue({
			taskId: "task-snap",
			taskMode: "code",
			clineMessages: [
				{ ts: 1, type: "say", say: "text", text: "hello" },
				{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ path: "a.ts", diff: "x" }) },
			],
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(client.postSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "instance-1",
				taskId: "task-snap",
				mode: "code",
				messages: expect.arrayContaining([expect.objectContaining({ text: "hello" })]),
			}),
		)
		bridge.dispose()
	})

	it("coalesces partial message events and flushes them", async () => {
		const bridge = await activateEligibleBridge()
		client.postEvents.mockClear()

		api.emit(RooCodeEventName.Message, {
			taskId: "task-1",
			action: "updated",
			message: { ts: 9, type: "say", say: "text", text: "par", partial: true, messageId: "m9" },
		})
		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					action: "updated",
					message: expect.objectContaining({ text: "par", partial: true }),
				}),
			]),
		)
		bridge.dispose()
	})

	it("throttles rapid partial flushes", async () => {
		const bridge = await activateEligibleBridge()
		client.postEvents.mockClear()

		api.emit(RooCodeEventName.Message, {
			taskId: "task-1",
			message: { ts: 1, type: "say", say: "text", text: "a", partial: true, messageId: "p1" },
		})
		api.emit(RooCodeEventName.Message, {
			taskId: "task-1",
			message: { ts: 1, type: "say", say: "text", text: "ab", partial: true, messageId: "p1" },
		})
		await vi.advanceTimersByTimeAsync(50)
		expect(client.postEvents).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(100)
		expect(client.postEvents).toHaveBeenCalledTimes(1)
		expect(client.postEvents).toHaveBeenCalledWith("instance-1", [
			expect.objectContaining({
				type: "message",
				taskId: "task-1",
				message: expect.objectContaining({ text: "ab", partial: true, messageId: "p1" }),
			}),
		])
		bridge.dispose()
	})

	it("drops event batches on postEvents 404", async () => {
		client.postEvents.mockResolvedValue({ ok: false, status: 404 })
		const bridge = await activateEligibleBridge()
		api.emit(RooCodeEventName.TaskIdle, "task-1")
		await vi.advanceTimersByTimeAsync(100)

		client.postEvents.mockClear()
		client.postEvents.mockResolvedValue({ ok: true, status: 200 })
		await vi.advanceTimersByTimeAsync(100)
		// 404 path drops the batch rather than re-queueing it.
		expect(client.postEvents).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("re-queues event batches when postEvents returns 401", async () => {
		client.postEvents.mockResolvedValue({ ok: false, status: 401 })
		const bridge = await activateEligibleBridge()
		api.emit(RooCodeEventName.TaskIdle, "task-1")
		await vi.advanceTimersByTimeAsync(100)
		expect(client.postEvents).toHaveBeenCalled()

		client.postEvents.mockClear()
		client.postEvents.mockResolvedValue({ ok: true, status: 200 })
		// not-eligible backoff is 30s; flush only retries after canCallServer() opens again.
		await vi.advanceTimersByTimeAsync(30_000 + 100)
		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([expect.objectContaining({ type: "task_idle", taskId: "task-1" })]),
		)
		bridge.dispose()
	})

	it("syncs when already active by republishing presence", async () => {
		const bridge = await activateEligibleBridge()
		client.postPresence.mockClear()
		provider.emit(RooCodeEventName.ProviderProfileChanged, {
			name: "Zoo Gateway",
			provider: providerIdentifiers.zooGateway,
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(client.postPresence).toHaveBeenCalled()
		expect(bridge.isActive()).toBe(true)
		bridge.dispose()
	})

	it("reacts to session start/end and secret changes", async () => {
		let secretListener: ((event: { key: string }) => void) | undefined
		context.secrets.onDidChange.mockImplementation((listener: (event: { key: string }) => void) => {
			secretListener = listener
			return { dispose: vi.fn() }
		})

		sessionActive = false
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)

		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		await bridge.setSessionActive(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		vi.mocked(getCachedZooCodeToken).mockReturnValue("")
		secretListener?.({ key: "zoo-code-session-token" })
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("generates and persists an instance id when none is stored", async () => {
		sessionActive = true
		context.globalState.get.mockImplementation((key: string) => {
			if (key === "zooRemoteControl.eventSeq") return -1
			if (key === "zooRemoteControl.sessionActive") return sessionActive
			return undefined
		})
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.getInstanceId()).toBe("test-session-id")
		expect(context.globalState.update).toHaveBeenCalledWith("zooRemoteControl.instanceId", "test-session-id")
		expect(bridge.isActive()).toBe(true)
		bridge.dispose()
	})

	it("does not activate when instance id persistence fails", async () => {
		sessionActive = true
		context.globalState.get.mockImplementation((key: string) => {
			if (key === "zooRemoteControl.eventSeq") return 0
			if (key === "zooRemoteControl.sessionActive") return sessionActive
			return undefined
		})
		context.globalState.update.mockImplementation(async (key: string) => {
			if (key === "zooRemoteControl.instanceId") {
				throw new Error("storage unavailable")
			}
			if (key === "zooRemoteControl.sessionActive") {
				sessionActive = true
			}
		})
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)
		expect(client.postPresence).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("awaits serialized event-seq persistence and stops enqueueing after persist failure", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		let rejectSeq: (error: Error) => void = () => {}
		const seqWrite = new Promise<void>((_resolve, reject) => {
			rejectSeq = reject
		})
		context.globalState.update.mockImplementation((key: string) => {
			if (key === "zooRemoteControl.eventSeq") {
				return seqWrite
			}
			return Promise.resolve()
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		api.emit(RooCodeEventName.TaskIdle, "task-1")
		await Promise.resolve()
		await Promise.resolve()
		expect(context.globalState.update).toHaveBeenCalledWith("zooRemoteControl.eventSeq", expect.any(Number))

		rejectSeq(new Error("seq write failed"))
		await Promise.resolve()
		await Promise.resolve()

		client.postEvents.mockClear()
		api.emit(RooCodeEventName.TaskIdle, "task-2")
		await vi.advanceTimersByTimeAsync(200)
		expect(client.postEvents).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("tolerates provider settings lookup failures", async () => {
		sessionActive = true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockImplementation(() => {
			throw new Error("settings boom")
		})
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("skips snapshot publish when the current task has no messages", async () => {
		provider.getCurrentTask.mockReturnValue({ taskId: "task-empty", clineMessages: undefined })
		const bridge = await activateEligibleBridge()
		expect(client.postSnapshot).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("publishes snapshot 404 as unavailable without crashing", async () => {
		provider.getCurrentTask.mockReturnValue({
			taskId: "task-snap",
			clineMessages: [{ ts: 1, type: "say", say: "text", text: "hi" }],
		})
		client.postSnapshot.mockResolvedValue({ ok: false, status: 404 })
		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(client.postSnapshot).toHaveBeenCalled()
		// Snapshot 404 shares the 60s unavailable backoff — presence must not fire again yet.
		client.postPresence.mockClear()
		await vi.advanceTimersByTimeAsync(15_000)
		expect(client.postPresence).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("deactivates during command poll when eligibility is lost before fetch", async () => {
		const bridge = await activateEligibleBridge()
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.openrouter,
		})
		client.getCommands.mockClear()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(bridge.isActive()).toBe(false)
		expect(client.getCommands).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("ignores command poll results after dispose", async () => {
		let resolveCommands: (value: {
			ok: boolean
			status: number
			body: { commands: Array<{ commandId: string; type: string; payload?: { text?: string } }> }
		}) => void = () => {}
		client.getCommands.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCommands = resolve
				}),
		)

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.getCommands).toHaveBeenCalledTimes(1)

		bridge.dispose()
		resolveCommands({
			ok: true,
			status: 200,
			body: {
				commands: [{ commandId: "late-1", type: "message", payload: { text: "too late" } }],
			},
		})
		await Promise.resolve()
		await Promise.resolve()

		expect(api.sendMessage).not.toHaveBeenCalled()
		expect(client.ackCommand).not.toHaveBeenCalled()
	})

	it("does not start overlapping command polls while one is in flight", async () => {
		let resolveCommands: (value: { ok: boolean; status: number; body: { commands: [] } }) => void = () => {}
		client.getCommands.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCommands = resolve
				}),
		)

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.getCommands).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.getCommands).toHaveBeenCalledTimes(1)

		resolveCommands({ ok: true, status: 200, body: { commands: [] } })
		await Promise.resolve()
		await Promise.resolve()

		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.getCommands).toHaveBeenCalledTimes(2)
		bridge.dispose()
	})

	it("acks unknown command types as failed", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [{ commandId: "u1", type: "not_a_real_command" }],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				commandId: "u1",
				status: "failed",
				errorCode: "unknown_command",
			}),
		)
		bridge.dispose()
	})
})
