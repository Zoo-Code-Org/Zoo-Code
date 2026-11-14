// npx vitest run core/tools/__tests__/writeToFileTool-partial-state-cleanup.spec.ts

import { RooCodeEventName } from "@roo-code/types"
import { vi, type MockedFunction } from "vitest"

import { type Task } from "../../task/Task"
import { writeToFileTool } from "../WriteToFileTool"
import { fileExistsAtPath } from "../../../utils/fs"

// Only the filesystem probe has to be observable; every other export of utils/fs stays real.
vi.mock("../../../utils/fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/fs")>()
	return { ...actual, fileExistsAtPath: vi.fn().mockResolvedValue(false) }
})

// The cleanup primitives only read these members, so a structural double is enough;
// the double assertion is the repo's existing pattern for private-method tests
// (see src/__tests__/removeClineFromStack-delegation.spec.ts).
interface CleanupTask {
	taskId: string
	instanceId: string
	once: MockedFunction<(...args: unknown[]) => unknown>
	off: MockedFunction<(...args: unknown[]) => unknown>
	diffViewProvider: {
		reset: MockedFunction<() => Promise<void>>
		revertChanges: MockedFunction<() => Promise<void>>
	}
	finalizePartialToolAsk: MockedFunction<() => Promise<void>>
}

function buildTask(taskId: string, instanceId: string): Task {
	const task: CleanupTask = {
		taskId,
		instanceId,
		once: vi.fn(),
		off: vi.fn(),
		diffViewProvider: {
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
		},
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),
	}
	return task as unknown as Task
}

describe("WriteToFileTool per-task partial-state cleanup", () => {
	afterEach(() => {
		writeToFileTool["taskPartialStreamState"].clear()
		vi.restoreAllMocks()
	})

	it("releases the task state and deregisters the abort listener", async () => {
		const task = buildTask("cleanup-task", "inst-1")
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(1)
		// The registration side of the pairing, asserted BEFORE the cleanup runs: the off()
		// assertion below only proves the right listener was deregistered if this one pins which
		// listener was registered in the first place.
		expect((task as unknown as CleanupTask).once).toHaveBeenCalledWith(
			RooCodeEventName.TaskAborted,
			state.abortCleanup,
		)

		writeToFileTool.clearTaskState(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect((task as unknown as CleanupTask).off).toHaveBeenCalledWith(
			RooCodeEventName.TaskAborted,
			state.abortCleanup,
		)
	})

	it("is a no-op for a task that never streamed", async () => {
		const task = buildTask("never-streamed", "inst-2")

		writeToFileTool.clearTaskState(task)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect((task as unknown as CleanupTask).off).not.toHaveBeenCalled()
	})

	it("logs and continues when resetting the diff view fails", async () => {
		const task = buildTask("reset-fails", "inst-3")
		const t = task as unknown as CleanupTask
		t.diffViewProvider.reset = vi.fn().mockRejectedValue(new Error("reset failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["resetDiffViewAfterWrite"](task)

		expect(errorSpy).toHaveBeenCalledWith("Error resetting write_to_file diff view:", expect.any(Error))
	})

	it("returns the revert failure so the caller can report the rollback failure", async () => {
		const task = buildTask("revert-fails", "inst-4")
		const t = task as unknown as CleanupTask
		const revertError = new Error("revert failed")
		t.diffViewProvider.revertChanges = vi.fn().mockRejectedValue(revertError)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(writeToFileTool["revertDiffChangesBeforeReset"](task)).resolves.toBe(revertError)

		expect(errorSpy).toHaveBeenCalledWith("Error reverting write_to_file diff view changes:", expect.any(Error))
	})

	it("logs and continues when finalizing the open partial ask fails", async () => {
		const task = buildTask("finalize-fails", "inst-5")
		const t = task as unknown as CleanupTask
		t.finalizePartialToolAsk = vi.fn().mockRejectedValue(new Error("finalize failed"))
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await writeToFileTool["finalizePartialToolAskAfterFailure"](task, "partial text")

		expect(errorSpy).toHaveBeenCalledWith("Error finalizing write_to_file partial tool ask:", expect.any(Error))
	})
})
// handlePartial() acquires per-task state and then crosses several awaits before it touches
// anything the user can see. A task that was aborted or abandoned mid-flight must not leave the
// registration behind and must not produce the partial ask or a diff preview.
describe("WriteToFileTool partial-delta cancellation", () => {
	// Structural double: handlePartial only reads these members before the diff view. The double
	// assertion is the repo's existing pattern for private-method tests.
	beforeEach(() => {
		// The probe mock comes from a module-level vi.mock factory, so its call history outlives a
		// single test unless it is reset here; the boundary assertions count on it.
		vi.mocked(fileExistsAtPath).mockReset().mockResolvedValue(false)
	})

	interface StreamTask {
		taskId: string
		instanceId: string
		abort: boolean
		abandoned: boolean
		cwd: string
		once: MockedFunction<(...args: unknown[]) => unknown>
		off: MockedFunction<(...args: unknown[]) => unknown>
		ask: MockedFunction<(type: string, text: string, partial?: boolean) => Promise<unknown>>
		finalizePartialToolAsk: MockedFunction<(text?: string) => Promise<void>>
		providerRef: { deref: () => { getState: () => Promise<Record<string, unknown>> } }
		diffViewProvider: {
			editType: "modify" | "create" | undefined
			isEditing: boolean
			open: MockedFunction<(relPath: string) => Promise<void>>
			update: MockedFunction<(content: string, single: boolean) => Promise<void>>
			revertChanges: MockedFunction<() => Promise<boolean>>
			reset: MockedFunction<() => Promise<void>>
		}
	}

	const buildStreamTask = (taskId: string, instanceId: string): StreamTask => ({
		taskId,
		instanceId,
		abort: false,
		abandoned: false,
		cwd: "/mock/cwd",
		once: vi.fn(),
		off: vi.fn(),
		ask: vi.fn().mockResolvedValue(undefined),
		finalizePartialToolAsk: vi.fn().mockResolvedValue(undefined),

		providerRef: { deref: () => ({ getState: async () => ({ experiments: {} }) }) },
		diffViewProvider: {
			editType: "create",
			isEditing: true,
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(true),
			reset: vi.fn().mockResolvedValue(undefined),
		},
	})

	const partialBlock = {
		type: "tool_use",
		name: "write_to_file",
		partial: true,
		params: { path: "src/demo.ts", content: "hello world" },
	} satisfies Record<string, unknown> as unknown as Parameters<(typeof writeToFileTool)["handlePartial"]>[1]

	// The path only counts as stable once the same path has been seen twice, so a delta that
	// should reach the ask has to start from an entry seeded by an earlier delta.
	const seedStablePath = (task: Task) => {
		const state = writeToFileTool["getTaskPartialStreamState"](task)
		state.lastSeenPartialPath = "src/demo.ts"
		return state
	}
	// A refused rollback plus an empty streamed document reaches handlePartial with an ask
	// already on screen and no preview to open, which used to leave that ask partial forever.
	it("finalizes the empty-content partial ask when a rollback was refused", async () => {
		const task = buildStreamTask("refused-empty-content", "inst-c6")
		seedStablePath(task as unknown as Task)
		const failureKey = writeToFileTool["getPartialStreamFailureKey"](task as unknown as Task)
		// No captured context on this refusal: the provider held no live edit to snapshot, so the refusal
		// keeps its task-wide reach and this delta is suppressed on that basis alone.
		writeToFileTool["taskRollbackFailures"].set(failureKey, [
			{
				error: new Error("EPERM: cannot restore the streamed document"),
				context: undefined,
			},
		])
		const emptyContentBlock = {
			...partialBlock,
			params: { path: "src/demo.ts", content: "" },
		}

		await writeToFileTool.handlePartial(task as unknown as Task, emptyContentBlock)

		expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining('"content":""'), true)
		expect(task.finalizePartialToolAsk).toHaveBeenCalledWith(expect.stringContaining('"content":""'))
		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
		expect(task.diffViewProvider.update).not.toHaveBeenCalled()
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		writeToFileTool["taskRollbackFailures"].delete(failureKey)
	})

	it("does not register per-task state for a task that already stopped", async () => {
		const task = buildStreamTask("cancel-before-register", "inst-c1")
		task.abort = true

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.once).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
	})

	it("releases the state and stops before the next boundary when the task aborts during getState()", async () => {
		const task = buildStreamTask("cancel-in-getstate", "inst-c2")
		// No editType yet, so the very next step after getState() would be the filesystem probe:
		// asserting the probe never ran pins THIS boundary. (Leaving editType set would let the
		// suppressed-focus branch release the state and return on its own, which proves nothing
		// about the check under test.)
		task.diffViewProvider.editType = undefined
		// The release assertion below needs the listener identity, not a function-shaped matcher.
		// Seeding through the call the case already makes is enough: it returns the per-task state
		// the abort listener is attached to, so no extra registration is invented here.
		const state = seedStablePath(task as unknown as Task)
		const releasedAbortCleanup = state.abortCleanup
		// The registration side of the pairing, asserted before the release. This is the only
		// listener-removal assertion in the tree that used a class matcher (measured with
		// git grep -n -e expect.any(Function) over src: 57 occurrences in 27 files, one of them on
		// an off() call, and zero on a once() call). The class version passes when nothing was ever
		// registered, which is the half of the contract this case exists for: the per-task state
		// binds its abortCleanup callback, handlePartial registers that reference through task.once,
		// and this early-exit path has to deregister the same one.
		expect(task.once).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, releasedAbortCleanup)
		task.providerRef.deref = () => ({
			getState: async () => {
				task.abort = true
				return { experiments: {} }
			},
		})

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(vi.mocked(fileExistsAtPath)).not.toHaveBeenCalled()
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, releasedAbortCleanup)
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("releases the state and skips the partial ask when the task is abandoned during the file probe", async () => {
		const task = buildStreamTask("cancel-in-probe", "inst-c3")
		// No editType yet forces the filesystem probe, the await boundary between the setup and the
		// first thing the user sees.
		task.diffViewProvider.editType = undefined
		seedStablePath(task as unknown as Task)
		const probe = vi.mocked(fileExistsAtPath)
		probe.mockImplementation(async () => {
			task.abandoned = true
			return false
		})

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(probe).toHaveBeenCalledTimes(1)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("does not open the diff view when the task aborts while the partial ask is in flight", async () => {
		const task = buildStreamTask("cancel-in-ask", "inst-c4")
		seedStablePath(task as unknown as Task)
		task.ask = vi.fn().mockImplementation(async () => {
			task.abort = true
			return undefined
		})

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(task.ask).toHaveBeenCalledTimes(1)
		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
		expect(task.diffViewProvider.update).not.toHaveBeenCalled()
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
	})

	it("reverts and closes the preview when the task aborts while open() is in flight", async () => {
		const task = buildStreamTask("cancel-in-open", "inst-c5")
		seedStablePath(task as unknown as Task)
		// No preview yet: this is the delta that calls open() itself, and open() is the await
		// boundary that sits between it and update().
		task.diffViewProvider.isEditing = false
		task.diffViewProvider.open = vi.fn().mockImplementation(async () => {
			task.abort = true
		})

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(task.diffViewProvider.open).toHaveBeenCalledTimes(1)
		// The preview open() installed is the thing at risk: the delta that would have streamed
		// into it has no approval path left, so update() must not run against it, and the
		// preview must not stand there holding content nobody approved.
		expect(task.diffViewProvider.update).not.toHaveBeenCalled()
		expect(task.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
		expect(task.diffViewProvider.reset).toHaveBeenCalledTimes(1)
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
	})
})
