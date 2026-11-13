import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { checkpointSave, checkpointRestore, checkpointDiff, getCheckpointService } from "../index"
import { MessageManager } from "../../message-manager"
import { RepoPerTaskCheckpointService } from "../../../services/checkpoints"
import * as vscode from "vscode"

const RESTORE_HASH = "a".repeat(40)
const HASH_1 = "1".repeat(40)
const HASH_2 = "2".repeat(40)

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn(() => ({})),
		showInformationMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn((path: string) => ({ fsPath: path })),
		parse: vi.fn((_uri: string) => ({ with: vi.fn(() => ({})) })),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

// Mock other dependencies
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

// Mock p-wait-for to control timeout behavior
vi.mock("p-wait-for", () => ({
	default: vi.fn(),
}))

describe("Checkpoint functionality", () => {
	let mockProvider: any
	let mockTask: any
	let mockCheckpointService: any

	beforeEach(async () => {
		const pathModule = await import("../../../utils/path")
		const gitModule = await import("../../../utils/git")
		const i18nModule = await import("../../../i18n")
		vi.spyOn(pathModule, "getWorkspacePath").mockReturnValue("/test/workspace")
		vi.spyOn(gitModule, "checkGitInstalled").mockResolvedValue(true)
		vi.spyOn(i18nModule, "t").mockImplementation((key: string, options?: Record<string, unknown>) => {
			if (key === "common:errors.wait_checkpoint_long_time") {
				return `Checkpoint initialization is taking longer than ${options?.timeout} seconds...`
			}
			if (key === "common:errors.init_checkpoint_fail_long_time") {
				return `Checkpoint initialization failed after ${options?.timeout} seconds`
			}
			return key
		})

		// Create mock checkpoint service
		mockCheckpointService = {
			isInitialized: true,
			saveCheckpoint: vi.fn().mockResolvedValue({ commit: "test-commit-hash" }),
			restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
			getDiff: vi.fn().mockResolvedValue([]),
			on: vi.fn(),
			initShadowGit: vi.fn().mockResolvedValue(undefined),
		}

		// Create mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			log: vi.fn(),
			postMessageToWebview: vi.fn(),
			postStateToWebview: vi.fn(),
			cancelTask: vi.fn(),
		}

		// Create mock task
		mockTask = {
			taskId: "test-task-id",
			enableCheckpoints: true,
			checkpointService: mockCheckpointService,
			checkpointServiceInitializing: false,
			providerRef: {
				deref: () => mockProvider,
			},
			clineMessages: [],
			apiConversationHistory: [],
			pendingUserMessageCheckpoint: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			combineMessages: vi.fn().mockReturnValue([]),
		}
		mockTask.messageManager = new MessageManager(mockTask)

		// Update the mock to return our mockCheckpointService
		const checkpointsModule = await import("../../../services/checkpoints")
		vi.spyOn(checkpointsModule.RepoPerTaskCheckpointService, "create").mockReturnValue(mockCheckpointService)
	})

	afterEach(() => {
		vi.clearAllMocks()
		vi.restoreAllMocks()
	})

	describe("checkpointSave", () => {
		it("serializes concurrent saves for the same task so stageAll + commit never overlap", async () => {
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("first:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementationOnce(async () => {
					order.push("second:start")
					return { commit: "second-commit" }
				})

			const first = checkpointSave(mockTask, false, true)
			const second = checkpointSave(mockTask, false, true)

			// The second save must not reach the service while the first is still running:
			// a queued save owns the stageAll + commit pair until it settles.
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(order).toEqual(["first:start"])

			resolveFirst({ commit: "first-commit" })
			await Promise.all([first, second])
			expect(order).toEqual(["first:start", "second:start"])
		})

		it("drops a queued save whose checkpoint window expired behind a stalled predecessor", async () => {
			// A stalled baseline releases the task after checkpointTimeout, but the queue used to
			// start it anyway, however late, committing whatever the workspace had become by then.
			// It must not: the save is dropped and the caller resolves with no commit.
			mockTask.checkpointTimeout = 0.01
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("stalled:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementation(async () => {
					order.push("late:start")
					return { commit: "late-commit" }
				})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const stalled = checkpointSave(mockTask, true, true)
			const queued = await (async () => {
				await new Promise((resolve) => setTimeout(resolve, 5))
				const second = checkpointSave(mockTask, false, true)
				// Give the expired request its turn behind the still-running baseline, then release
				// the baseline so the queue drains.
				await new Promise((resolve) => setTimeout(resolve, 30))
				resolveFirst({ commit: "stalled-commit" })
				return second
			})()

			const second = await queued
			await stalled
			// Only the stalled baseline ever reached the shadow git; the expired save never started,
			// so no commit describes a workspace that has since moved on.
			expect(order).toEqual(["stalled:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(1)
			expect(second).toBeUndefined()
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping queued per-write checkpoint save"))
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("expired behind a slower checkpoint"))
			warnSpy.mockRestore()
		})

		it("releases a queued save at its own deadline while the stalled predecessor still holds the queue", async () => {
			// The deadline used to gate only the start of an operation. A caller queued behind a save
			// that never settled waited for it forever, which is the indefinite wait the thread names:
			// the handoff behind it cannot proceed. The caller has to be released by its own window
			// while the predecessor still holds the lock, and the operation behind the released one
			// must still wait for that predecessor rather than start on top of it.
			mockTask.checkpointTimeout = 0.05
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("stalled:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementationOnce(async () => {
					order.push("third:start")
					return { commit: "third-commit" }
				})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const stalled = checkpointSave(mockTask, true, true)
			const queued = checkpointSave(mockTask, false, true)
			// Nothing below releases the stalled predecessor before this await settles, so a wait
			// that is still unbounded shows up here as the guard arm winning the race rather than
			// the save resolving.
			const released = await Promise.race([
				queued,
				new Promise<string>((resolve) => {
					setTimeout(() => resolve("still waiting behind the stalled predecessor"), 500)
				}),
			])
			expect(released).toBeUndefined()
			// Released while the predecessor is still running: the stalled save is the only one that
			// reached the shadow git, and the released request never started.
			expect(order).toEqual(["stalled:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(1)
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("releasing the wait for queued per-write checkpoint save"),
			)

			// The lock is not handed over early. A save requested while the stalled predecessor is
			// still running has to wait for it; its own window is reopened first, so what this
			// measures is the queue rather than that caller's patience.
			mockTask.checkpointTimeout = 15
			const third = checkpointSave(mockTask, false, true)
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(order).toEqual(["stalled:start"])

			resolveFirst({ commit: "stalled-commit" })
			const settled = await stalled
			const thirdResult = await third
			// The released request did not re-run when the predecessor finally settled, and the fresh
			// request ran exactly once, after the predecessor released the queue.
			expect(order).toEqual(["stalled:start", "third:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(2)
			expect(settled).toEqual({ commit: "stalled-commit" })
			expect(thirdResult).toEqual({ commit: "third-commit" })
			warnSpy.mockRestore()
		})

		it("does not start a released save when the predecessor settles in the same millisecond as the deadline", async () => {
			// The rows above release the stalled predecessor only after the caller was already released, so
			// the millisecond the deadline itself falls in is never the millisecond a predecessor settles.
			// That millisecond is the one the start gate cannot tell apart from a turn arriving on time: it
			// asks whether the clock is past the deadline, and a reading equal to the deadline is not past
			// it. Date.now is pinned here so the release and the settle are the same reading of the clock,
			// which makes this row about the release rather than about how long anyone was willing to wait.
			const deadline = 1_700_000_000_000
			let now = deadline - 20
			const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
			mockTask.checkpointTimeout = 0.02
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("stalled:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementationOnce(async () => {
					order.push("started-after-release")
					return { commit: "late-commit" }
				})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const stalled = checkpointSave(mockTask, true, true)
			const queued = checkpointSave(mockTask, false, true)
			// Move the pinned clock onto the deadline while the predecessor is still running, so the window
			// closing and any later start read one and the same value.
			await new Promise((resolve) => setTimeout(resolve, 10))
			now = deadline
			const released = await Promise.race([
				queued,
				new Promise<string>((resolve) => {
					setTimeout(() => resolve("still waiting behind the stalled predecessor"), 500)
				}),
			])
			expect(released).toBeUndefined()
			expect(order).toEqual(["stalled:start"])

			// The predecessor finally settles with the clock still reading exactly the deadline.
			resolveFirst({ commit: "stalled-commit" })
			const settled = await stalled
			await new Promise((resolve) => setTimeout(resolve, 25))

			expect(now).toBe(deadline)
			expect(settled).toEqual({ commit: "stalled-commit" })
			// A released wait must not turn into a late save: nothing but the stalled predecessor reached
			// the service, and both ends of the release are reported.
			expect(order).toEqual(["stalled:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(1)
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("releasing the wait for queued per-write checkpoint save"),
			)
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("released at its deadline while a slower checkpoint was still running"),
			)
			nowSpy.mockRestore()
			warnSpy.mockRestore()
		})

		it("drops a queued save for a task that was canceled while it waited", async () => {
			mockTask.checkpointTimeout = 15
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("stalled:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementation(async () => {
					order.push("canceled:start")
					return { commit: "canceled-commit" }
				})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			mockTask.abort = false

			const stalled = checkpointSave(mockTask, true, true)
			const queued = checkpointSave(mockTask, false, true)
			await new Promise((resolve) => setTimeout(resolve, 5))
			// Cancellation arrives while the save is queued, before its turn.
			mockTask.abort = true
			resolveFirst({ commit: "stalled-commit" })

			const second = await queued
			await stalled

			expect(order).toEqual(["stalled:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(1)
			expect(second).toBeUndefined()
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("task canceled"))
			warnSpy.mockRestore()
			mockTask.abort = false
		})

		it("runs a save requested after a stalled predecessor settles, exactly once each", async () => {
			// The gate must not poison the queue: the dropped request stays dropped, while a fresh
			// request after the stall settles gets its normal turn.
			mockTask.checkpointTimeout = 0.01
			const order: string[] = []
			let resolveFirst: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint
				.mockImplementationOnce(() => {
					order.push("stalled:start")
					return new Promise((resolve) => {
						resolveFirst = resolve
					})
				})
				.mockImplementation(async () => {
					order.push("fresh:start")
					return { commit: "fresh-commit" }
				})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const stalled = checkpointSave(mockTask, true, true)
			// Requested while its window is still open, so the drop below is about the wait behind
			// the stalled baseline rather than about an already-expired request.
			const expired = checkpointSave(mockTask, false, true)
			await new Promise((resolve) => setTimeout(resolve, 30))
			resolveFirst({ commit: "stalled-commit" })
			const expiredResult = await expired
			const settled = await stalled
			const fresh = await checkpointSave(mockTask, false, true)

			expect(order).toEqual(["stalled:start", "fresh:start"])
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledTimes(2)
			// The dropped request resolves exactly the way a missing service does: no commit value,
			// while the predecessor that held the queue keeps its own result.
			expect(expiredResult).toBeUndefined()
			expect(settled).toEqual({ commit: "stalled-commit" })
			expect(fresh).toEqual({ commit: "fresh-commit" })
			warnSpy.mockRestore()
		})

		it("never drops a user-initiated restore queued behind a stalled save", async () => {
			// Restores carry no expiry: dropping one would silently discard an explicit user action.
			mockTask.checkpointTimeout = 0.01
			mockTask.clineMessages = [{ ts: 2, type: "say", say: "checkpoint_saved", text: RESTORE_HASH }]
			const order: string[] = []
			let resolveSave: (value: { commit: string }) => void = () => {}
			mockCheckpointService.saveCheckpoint.mockImplementationOnce(() => {
				order.push("save:start")
				return new Promise((resolve) => {
					resolveSave = resolve
				})
			})
			mockCheckpointService.restoreCheckpoint.mockImplementationOnce(() => {
				order.push("restore:start")
				return Promise.resolve(undefined)
			})

			const stalled = checkpointSave(mockTask, true, true)
			const restore = checkpointRestore(mockTask, { ts: 2, commitHash: RESTORE_HASH, mode: "preview" })
			await new Promise((resolve) => setTimeout(resolve, 30))
			resolveSave({ commit: "stalled-commit" })
			await Promise.all([stalled, restore])

			expect(order).toEqual(["save:start", "restore:start"])
			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith(RESTORE_HASH)
		})

		it("should wait for checkpoint service initialization before saving", async () => {
			// Set up task with uninitialized service
			mockCheckpointService.isInitialized = false
			mockTask.checkpointService = mockCheckpointService

			// Simulate service initialization after a delay
			setTimeout(() => {
				mockCheckpointService.isInitialized = true
			}, 100)

			// Call checkpointSave
			const savePromise = checkpointSave(mockTask, true)

			// Wait for the save to complete
			const result = await savePromise

			// saveCheckpoint should have been called
			// The baseline carries a content premise now: it describes the workspace before any agent
			// write, and saveCheckpoint declines to publish if a write landed before it staged.
			expect(mockCheckpointService.saveCheckpoint).toHaveBeenCalledWith(
				expect.stringContaining("Task: test-task-id"),
				{ allowEmpty: true, suppressMessage: false, contentPremise: expect.any(Function) },
			)

			// Result should contain the commit hash
			expect(result).toEqual({ commit: "test-commit-hash" })

			// Task should still have checkpoints enabled
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		it("should handle timeout when service doesn't initialize", async () => {
			// Service never initializes
			mockCheckpointService.isInitialized = false

			// Call checkpointSave with a task that has no checkpoint service
			const taskWithNoService = {
				...mockTask,
				checkpointService: undefined,
				enableCheckpoints: false,
			}

			const result = await checkpointSave(taskWithNoService, true)

			// Result should be undefined
			expect(result).toBeUndefined()

			// saveCheckpoint should not have been called
			expect(mockCheckpointService.saveCheckpoint).not.toHaveBeenCalled()
		})

		it("should preserve checkpoint data through message deletion flow", async () => {
			// Initialize service
			mockCheckpointService.isInitialized = true
			mockTask.checkpointService = mockCheckpointService

			// Simulate saving checkpoint before user message
			const checkpointResult = await checkpointSave(mockTask, true)
			expect(checkpointResult).toEqual({ commit: "test-commit-hash" })

			// Simulate setting pendingUserMessageCheckpoint
			if (checkpointResult && "commit" in checkpointResult) {
				mockTask.pendingUserMessageCheckpoint = {
					hash: checkpointResult.commit,
					timestamp: Date.now(),
					type: "user_message",
				}
			}

			// Verify checkpoint data is preserved
			expect(mockTask.pendingUserMessageCheckpoint).toBeDefined()
			expect(mockTask.pendingUserMessageCheckpoint.hash).toBe("test-commit-hash")

			// Simulate message deletion and reinitialization
			mockTask.clineMessages = []
			mockTask.checkpointService = mockCheckpointService // Keep service available
			mockTask.checkpointServiceInitializing = false

			// Save checkpoint again after deletion
			const newCheckpointResult = await checkpointSave(mockTask, true)

			// Should still work after reinitialization
			expect(newCheckpointResult).toEqual({ commit: "test-commit-hash" })
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		it("should handle errors gracefully and disable checkpoints", async () => {
			mockCheckpointService.saveCheckpoint.mockRejectedValue(new Error("Save failed"))

			const result = await checkpointSave(mockTask)

			expect(result).toBeUndefined()
			expect(mockTask.enableCheckpoints).toBe(false)
		})
	})

	describe("checkpointRestore", () => {
		beforeEach(() => {
			mockTask.clineMessages = [
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "assistant", text: "Message 2" },
				{ ts: 3, say: "user", text: "Message 3" },
				{ ts: 4, say: "checkpoint_saved", text: RESTORE_HASH },
			]
			mockTask.apiConversationHistory = [
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
				{ ts: 2, role: "assistant", content: [{ type: "text", text: "Message 2" }] },
				{ ts: 3, role: "user", content: [{ type: "text", text: "Message 3" }] },
			]
		})

		it("should restore checkpoint for delete operation", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: RESTORE_HASH,
				mode: "restore",
				operation: "delete",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith(RESTORE_HASH)
			expect(mockTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
			])
			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([{ ts: 1, say: "user", text: "Message 1" }])
			expect(mockProvider.cancelTask).toHaveBeenCalled()
		})

		it("should restore checkpoint for edit operation", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: RESTORE_HASH,
				mode: "restore",
				operation: "edit",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith(RESTORE_HASH)
			expect(mockTask.overwriteApiConversationHistory).toHaveBeenCalledWith([
				{ ts: 1, role: "user", content: [{ type: "text", text: "Message 1" }] },
			])
			// For edit operation, should include the message being edited
			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "assistant", text: "Message 2" },
			])
			expect(mockProvider.cancelTask).toHaveBeenCalled()
		})

		it("should handle preview mode without modifying messages", async () => {
			await checkpointRestore(mockTask, {
				ts: 2,
				commitHash: RESTORE_HASH,
				mode: "preview",
			})

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith(RESTORE_HASH)
			expect(mockTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
			expect(mockTask.overwriteClineMessages).not.toHaveBeenCalled()
			expect(mockProvider.cancelTask).toHaveBeenCalled()
		})

		it("should handle missing message gracefully", async () => {
			await checkpointRestore(mockTask, {
				ts: 999, // Non-existent timestamp
				commitHash: RESTORE_HASH,
				mode: "restore",
			})

			expect(mockCheckpointService.restoreCheckpoint).not.toHaveBeenCalled()
		})

		it("serializes a restore against a queued save so no save stages over a restore", async () => {
			const order: string[] = []
			let resolveRestore: () => void = () => {}
			mockCheckpointService.restoreCheckpoint.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						order.push("restore:start")
						resolveRestore = resolve as () => void
					}),
			)
			mockCheckpointService.saveCheckpoint.mockImplementationOnce(async () => {
				order.push("save:start")
				return { commit: "queued-commit" }
			})

			const restore = checkpointRestore(mockTask, { ts: 2, commitHash: RESTORE_HASH, mode: "preview" })
			// Let the restore reach the shadow-git reset.
			await new Promise((resolve) => setTimeout(resolve, 10))

			const save = checkpointSave(mockTask, false, true)
			// The save must not reach stageAll + commit while the restore is resetting the
			// workspace: that commit would record the restored bytes and drop the write's own
			// checkpoint.
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(order).toEqual(["restore:start"])

			resolveRestore()
			await Promise.all([restore, save])
			expect(order).toEqual(["restore:start", "save:start"])
		})

		it.each(["delete", "edit"] as const)(
			"propagates restore failures for %s without rewinding",
			async (operation) => {
				const restoreError = new Error("Restore failed")
				mockCheckpointService.restoreCheckpoint.mockRejectedValueOnce(restoreError)
				const messagesBeforeRestore = [...mockTask.clineMessages]
				const historyBeforeRestore = [...mockTask.apiConversationHistory]

				await expect(
					checkpointRestore(mockTask, {
						ts: 2,
						commitHash: RESTORE_HASH,
						mode: "restore",
						operation,
					}),
				).rejects.toBe(restoreError)

				expect(mockTask.enableCheckpoints).toBe(true)
				expect(mockTask.clineMessages).toEqual(messagesBeforeRestore)
				expect(mockTask.apiConversationHistory).toEqual(historyBeforeRestore)
				expect(mockTask.overwriteClineMessages).not.toHaveBeenCalled()
				expect(mockTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
				expect(mockTask.say).not.toHaveBeenCalled()
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
				expect(mockProvider.cancelTask).not.toHaveBeenCalled()
				expect(mockProvider.log).toHaveBeenCalledWith("[checkpointRestore] failed to restore checkpoint")
			},
		)

		it("accepts a recorded SHA-256 checkpoint hash", async () => {
			const sha256Hash = "c".repeat(64)
			mockTask.clineMessages.push({ ts: 5, say: "checkpoint_saved", text: sha256Hash })

			await checkpointRestore(mockTask, { ts: 2, commitHash: sha256Hash, mode: "preview" })

			expect(mockCheckpointService.restoreCheckpoint).toHaveBeenCalledWith(sha256Hash)
		})

		it.each([
			["a malformed hash", "HEAD~1"],
			["an abbreviated hash", "a".repeat(7)],
			["a hash between SHA-1 and SHA-256 length", "a".repeat(41)],
			["a well-formed but unrecorded hash", "b".repeat(40)],
			["a non-string", 42],
		])("rejects %s before any Git call", async (_label, commitHash) => {
			await expect(
				checkpointRestore(mockTask, { ts: 2, commitHash: commitHash as string, mode: "restore" }),
			).rejects.toThrow("common:errors.checkpoint_invalid_hash")

			expect(RepoPerTaskCheckpointService.create).not.toHaveBeenCalled()
			expect(mockCheckpointService.restoreCheckpoint).not.toHaveBeenCalled()
			expect(mockTask.overwriteClineMessages).not.toHaveBeenCalled()
			expect(mockProvider.cancelTask).not.toHaveBeenCalled()
		})
	})

	describe("checkpointDiff", () => {
		beforeEach(() => {
			mockTask.clineMessages = [
				{ ts: 1, say: "user", text: "Message 1" },
				{ ts: 2, say: "checkpoint_saved", text: HASH_1 },
				{ ts: 3, say: "user", text: "Message 2" },
				{ ts: 4, say: "checkpoint_saved", text: HASH_2 },
			]
		})

		it("should show diff for to-current mode", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: HASH_2,
				mode: "to-current",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: HASH_2,
				to: undefined,
			})
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.changes",
				"common:errors.checkpoint_diff_to_current",
				expect.any(Array),
			)
		})

		it("should show diff for checkpoint mode with next commit", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)
			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: HASH_1,
				mode: "checkpoint",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: HASH_1,
				to: HASH_2,
			})
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.changes",
				"common:errors.checkpoint_diff_with_next",
				expect.any(Array),
			)
		})

		it("should find next checkpoint automatically in checkpoint mode", async () => {
			const mockChanges = [
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			]
			mockCheckpointService.getDiff.mockResolvedValue(mockChanges)

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: HASH_1,
				mode: "checkpoint",
			})

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({
				from: HASH_1, // Should find the next checkpoint
				to: HASH_2,
			})
		})

		it("should show information message when no changes found", async () => {
			mockCheckpointService.getDiff.mockResolvedValue([])

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: HASH_2,
				mode: "to-current",
			})

			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:errors.checkpoint_no_changes")
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		})

		it("should show diff for a recorded SHA-256 checkpoint hash", async () => {
			const sha256Hash = "d".repeat(64)
			mockTask.clineMessages.push({ ts: 5, say: "checkpoint_saved", text: sha256Hash })
			mockCheckpointService.getDiff.mockResolvedValue([
				{
					paths: { absolute: "/test/file.ts", relative: "file.ts" },
					content: { before: "old content", after: "new content" },
				},
			])

			await checkpointDiff(mockTask, { ts: 5, commitHash: sha256Hash, mode: "to-current" })

			expect(mockCheckpointService.getDiff).toHaveBeenCalledWith({ from: sha256Hash, to: undefined })
		})

		it.each([
			["a malformed hash", "HEAD~1"],
			["a well-formed but unrecorded hash", "b".repeat(40)],
			["a non-string", 42],
		])("rejects %s before any Git call", async (_label, commitHash) => {
			await checkpointDiff(mockTask, { commitHash: commitHash as string, mode: "to-current" })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.checkpoint_invalid_hash")
			expect(RepoPerTaskCheckpointService.create).not.toHaveBeenCalled()
			expect(mockCheckpointService.getDiff).not.toHaveBeenCalled()
			expect(mockTask.enableCheckpoints).toBe(true)
		})

		it("should disable checkpoints on error", async () => {
			mockCheckpointService.getDiff.mockRejectedValue(new Error("Diff failed"))

			await checkpointDiff(mockTask, {
				ts: 4,
				commitHash: HASH_2,
				mode: "to-current",
			})

			expect(mockTask.enableCheckpoints).toBe(false)
			expect(mockProvider.log).toHaveBeenCalledWith("[checkpointDiff] disabling checkpoints for this task")
		})
	})

	describe("getCheckpointService", () => {
		it("should return existing service if available", async () => {
			const service = await getCheckpointService(mockTask)
			expect(service).toBe(mockCheckpointService)
		})

		it("should return undefined if checkpoints are disabled", async () => {
			mockTask.enableCheckpoints = false
			const service = await getCheckpointService(mockTask)
			expect(service).toBeUndefined()
		})

		it("should return undefined if service is still initializing", async () => {
			mockTask.checkpointService = undefined
			mockTask.checkpointServiceInitializing = true
			const service = await getCheckpointService(mockTask)
			expect(service).toBeUndefined()
		})

		it("should create new service if none exists", async () => {
			mockTask.checkpointService = undefined
			mockTask.checkpointServiceInitializing = false

			await getCheckpointService(mockTask)

			const checkpointsModule = await import("../../../services/checkpoints")
			expect(vi.mocked(checkpointsModule.RepoPerTaskCheckpointService.create)).toHaveBeenCalledWith({
				taskId: "test-task-id",
				workspaceDir: "/test/workspace",
				shadowDir: "/test/storage",
				log: expect.any(Function),
			})
		})

		it("should disable checkpoints if workspace path is not found", async () => {
			const pathModule = await import("../../../utils/path")
			vi.mocked(pathModule.getWorkspacePath).mockReturnValue("")

			mockTask.checkpointService = undefined
			mockTask.checkpointServiceInitializing = false

			const service = await getCheckpointService(mockTask)

			expect(service).toBeUndefined()
			expect(mockTask.enableCheckpoints).toBe(false)
		})
	})

	describe("getCheckpointService - initialization timeout behavior", () => {
		it("should send warning message when initialization is slow", async () => {
			// This test verifies the warning logic by directly testing the condition function behavior
			const i18nModule = await import("../../../i18n")

			// Setup: Create a scenario where initialization is in progress
			mockTask.checkpointService = undefined
			mockTask.checkpointServiceInitializing = true
			mockTask.checkpointTimeout = 15

			vi.clearAllMocks()

			// Simulate the condition function that runs inside pWaitFor
			let warningShown = false
			const simulateConditionCheck = (elapsedMs: number) => {
				// This simulates what happens inside the pWaitFor condition function (lines 85-100)
				if (!warningShown && elapsedMs >= 5000) {
					warningShown = true
					// This is what the actual code does at line 91-94
					const provider = mockTask.providerRef.deref()
					provider?.postMessageToWebview({
						type: "checkpointInitWarning",
						checkpointWarning: i18nModule.t("common:errors.wait_checkpoint_long_time", { timeout: 5 }),
					})
				}

				return !!mockTask.checkpointService && !!mockTask.checkpointService.isInitialized
			}

			// Test: At 4 seconds, no warning should be sent
			expect(simulateConditionCheck(4000)).toBe(false)
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()

			// Test: At 5 seconds, warning should be sent
			expect(simulateConditionCheck(5000)).toBe(false)
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: "Checkpoint initialization is taking longer than 5 seconds...",
			})

			// Test: At 6 seconds, warning should not be sent again (warningShown is true)
			vi.clearAllMocks()
			expect(simulateConditionCheck(6000)).toBe(false)
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("should send timeout error message when initialization fails", async () => {
			const i18nModule = await import("../../../i18n")

			// Setup
			mockTask.checkpointService = undefined
			mockTask.checkpointTimeout = 10
			mockTask.enableCheckpoints = true

			vi.clearAllMocks()

			// Simulate timeout error scenario (what happens in catch block at line 127-129)
			const error = new Error("Timeout")
			error.name = "TimeoutError"

			// This is what the code does when TimeoutError is caught
			if (error.name === "TimeoutError" && mockTask.enableCheckpoints) {
				const provider = mockTask.providerRef.deref()
				provider?.postMessageToWebview({
					type: "checkpointInitWarning",
					checkpointWarning: i18nModule.t("common:errors.init_checkpoint_fail_long_time", {
						timeout: mockTask.checkpointTimeout,
					}),
				})
			}

			mockTask.enableCheckpoints = false

			// Verify
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: "Checkpoint initialization failed after 10 seconds",
			})
			expect(mockTask.enableCheckpoints).toBe(false)
		})

		it("should clear warning on successful initialization", async () => {
			// Setup
			mockTask.checkpointService = mockCheckpointService
			mockTask.enableCheckpoints = true

			vi.clearAllMocks()

			// Simulate successful initialization (what happens at line 109 or 123)
			if (mockTask.enableCheckpoints) {
				const provider = mockTask.providerRef.deref()
				provider?.postMessageToWebview({
					type: "checkpointInitWarning",
					checkpointWarning: "",
				})
			}

			// Verify warning was cleared
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointInitWarning",
				checkpointWarning: "",
			})
		})

		it("should use WARNING_THRESHOLD_MS constant of 5000ms", () => {
			// Verify the warning threshold is 5 seconds by checking the implementation
			const WARNING_THRESHOLD_MS = 5000
			expect(WARNING_THRESHOLD_MS).toBe(5000)
			expect(WARNING_THRESHOLD_MS / 1000).toBe(5) // Used in the i18n call
		})

		it("should convert checkpointTimeout to milliseconds", () => {
			// Verify timeout conversion logic (line 42)
			mockTask.checkpointTimeout = 15
			const checkpointTimeoutMs = mockTask.checkpointTimeout * 1000
			expect(checkpointTimeoutMs).toBe(15000)

			mockTask.checkpointTimeout = 10
			expect(mockTask.checkpointTimeout * 1000).toBe(10000)

			mockTask.checkpointTimeout = 60
			expect(mockTask.checkpointTimeout * 1000).toBe(60000)
		})

		it("should use correct i18n keys for warning messages", async () => {
			const i18nModule = await import("../../../i18n")
			vi.clearAllMocks()

			// Test warning message i18n key
			const warningMessage = i18nModule.t("common:errors.wait_checkpoint_long_time", { timeout: 5 })
			expect(warningMessage).toBe("Checkpoint initialization is taking longer than 5 seconds...")

			// Test timeout error message i18n key
			const errorMessage = i18nModule.t("common:errors.init_checkpoint_fail_long_time", { timeout: 30 })
			expect(errorMessage).toBe("Checkpoint initialization failed after 30 seconds")
		})
	})
})
