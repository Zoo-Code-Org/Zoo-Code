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

// Private members are reached by bracket notation (AGENTS.md: no `as any`).
const stateFor = (task: Task) => writeToFileTool["taskPartialStreamState"].get(`${task.taskId}.${task.instanceId}`)

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
		providerRef: { deref: () => { getState: () => Promise<Record<string, unknown>> } }
		diffViewProvider: {
			editType: "modify" | "create" | undefined
			isEditing: boolean
			open: MockedFunction<(relPath: string) => Promise<void>>
			update: MockedFunction<(content: string, single: boolean) => Promise<void>>
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
		providerRef: { deref: () => ({ getState: async () => ({ experiments: {} }) }) },
		diffViewProvider: {
			editType: "create",
			isEditing: true,
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
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
		seedStablePath(task as unknown as Task)
		task.providerRef.deref = () => ({
			getState: async () => {
				task.abort = true
				return { experiments: {} }
			},
		})

		await writeToFileTool.handlePartial(task as unknown as Task, partialBlock)

		expect(vi.mocked(fileExistsAtPath)).not.toHaveBeenCalled()
		expect(writeToFileTool["taskPartialStreamState"].size).toBe(0)
		expect(task.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, expect.any(Function))
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
})
