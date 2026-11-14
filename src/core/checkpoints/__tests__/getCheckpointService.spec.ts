import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { RepoPerTaskCheckpointService } from "../../../services/checkpoints"
import { checkGitInstalled } from "../../../utils/git"
import { getCheckpointService } from "../index"

vi.mock("../../../services/checkpoints", () => ({
	RepoPerTaskCheckpointService: { create: vi.fn() },
}))

vi.mock("../../../utils/git", () => ({
	checkGitInstalled: vi.fn(),
}))

vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn(() => "/workspace"),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

/**
 * Structural service double: getCheckpointService only registers listeners,
 * awaits initShadowGit, and reads isInitialized. The double assertion at the
 * create() call sites is confined to this file (AGENTS.md last-resort cast):
 * the real class carries a Git handle and event surface the test never
 * exercises.
 */
function serviceDouble(initShadowGitImpl: () => Promise<void>) {
	const listeners = new Map<string, (...args: unknown[]) => void>()
	let initialized = false
	const svc = {
		on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			listeners.set(event, cb)
		}),
		initShadowGit: vi.fn(() => initShadowGitImpl()),
		get isInitialized() {
			return initialized
		},
		completeInit: () => {
			initialized = true
			listeners.get("initialize")?.()
		},
	}
	return svc
}

function makeTask(): Task {
	return {
		taskId: "task-init",
		cwd: "/workspace",
		enableCheckpoints: true,
		checkpointService: undefined,
		checkpointServiceInitializing: false,
		checkpointTimeout: 1,
		providerRef: {
			deref: vi.fn().mockReturnValue({
				context: { globalStorageUri: { fsPath: "/tmp/b3-init-storage" } },
				postMessageToWebview: vi.fn(),
				log: vi.fn(),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
	} as unknown as Task
}

describe("getCheckpointService initialization failures", () => {
	beforeEach(() => {
		vi.mocked(checkGitInstalled).mockReset()
		vi.mocked(RepoPerTaskCheckpointService.create).mockReset()
	})

	it("does not store a service whose shadow-git initialization failed", async () => {
		vi.mocked(checkGitInstalled).mockResolvedValue(true)
		const failing = serviceDouble(async () => {
			throw new Error("shadow git init exploded")
		})
		vi.mocked(RepoPerTaskCheckpointService.create).mockReturnValue(
			failing as unknown as RepoPerTaskCheckpointService,
		)

		const task = makeTask()
		const service = await getCheckpointService(task)

		// The failed service must not be stored: a stored uninitialized handle
		// would be returned by the fast path to every later save, and the
		// initializing flag must not strand later lookups in a wait for an
		// initialization that already died.
		expect(service).toBeUndefined()
		expect(task.checkpointService).toBeUndefined()
		expect(task.checkpointServiceInitializing).toBe(false)
		expect(task.enableCheckpoints).toBe(false)
	})

	it("does not store a service when Git is not installed", async () => {
		vi.mocked(checkGitInstalled).mockResolvedValue(false)
		const svc = serviceDouble(async () => {})
		vi.mocked(RepoPerTaskCheckpointService.create).mockReturnValue(svc as unknown as RepoPerTaskCheckpointService)

		const task = makeTask()
		const service = await getCheckpointService(task)

		expect(service).toBeUndefined()
		expect(task.checkpointService).toBeUndefined()
		expect(task.checkpointServiceInitializing).toBe(false)
		expect(task.enableCheckpoints).toBe(false)
	})

	it("stores an initialized service on the success path", async () => {
		vi.mocked(checkGitInstalled).mockResolvedValue(true)
		const svc = serviceDouble(async () => {
			svc.completeInit()
		})
		vi.mocked(RepoPerTaskCheckpointService.create).mockReturnValue(svc as unknown as RepoPerTaskCheckpointService)

		const task = makeTask()
		const service = await getCheckpointService(task)

		expect(service).toBe(svc)
		expect(task.checkpointService).toBe(svc)
		expect(task.checkpointServiceInitializing).toBe(false)
		expect(task.enableCheckpoints).toBe(true)
	})
})

describe("getCheckpointService initialization handoff", () => {
	beforeEach(() => {
		vi.mocked(checkGitInstalled).mockReset()
		vi.mocked(RepoPerTaskCheckpointService.create).mockReset()
	})

	it("hands a caller whose own window expired back to the initialization still running", async () => {
		vi.mocked(checkGitInstalled).mockResolvedValue(true)
		let releaseInit = () => {}
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve
		})
		const svc = serviceDouble(async () => {
			await initGate
			svc.completeInit()
		})
		vi.mocked(RepoPerTaskCheckpointService.create).mockReturnValue(svc as unknown as RepoPerTaskCheckpointService)

		const task = makeTask()
		const provider = task.providerRef.deref()
		// A caller window far shorter than the initialization it joined: the wait is bounded per
		// caller, so this one has to give up while the operation it waited on keeps running.
		task.checkpointTimeout = 0.05

		const started = getCheckpointService(task)
		const joined = await getCheckpointService(task, { interval: 10 })

		expect(joined).toBeUndefined()
		// An expired window is this caller running out of patience, not the initialization failing:
		// it reports no service, but it neither ends the initialization it did not start nor takes
		// the task's checkpoints away - the save that gave up is retried on a later loop entry.
		expect(task.enableCheckpoints).toBe(true)
		expect(task.checkpointServiceInitializing).toBe(true)
		expect(provider?.postMessageToWebview).toHaveBeenCalledWith({
			type: "checkpointInitWarning",
			checkpointWarning: { type: "WAIT_TIMEOUT", timeout: 0.05 },
		})
		expect(provider?.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "checkpointInitWarning",
			checkpointWarning: { type: "INIT_TIMEOUT", timeout: 0.05 },
		})

		releaseInit()

		const [starter, late] = await Promise.all([started, getCheckpointService(task, { interval: 10 })])

		expect(starter).toBe(svc)
		// The late lookup joins the operation that was still in flight rather than starting another
		// one, so the task ends up with a single shadow git directory and a single service.
		expect(late).toBe(svc)
		expect(RepoPerTaskCheckpointService.create).toHaveBeenCalledTimes(1)
		expect(task.checkpointService).toBe(svc)
	})

	it("still releases the task when a flag is left with no initialization behind it", async () => {
		vi.mocked(checkGitInstalled).mockResolvedValue(true)
		const svc = serviceDouble(async () => {})
		vi.mocked(RepoPerTaskCheckpointService.create).mockReturnValue(svc as unknown as RepoPerTaskCheckpointService)

		const task = makeTask()
		const provider = task.providerRef.deref()
		task.checkpointTimeout = 0.05
		// A released flag with no service behind it and nothing in the in-flight map: there is no
		// operation left to join, so the wait can only end in a timeout, and that one is reported
		// as the initialization having failed - the behavior this file pins above.
		task.checkpointServiceInitializing = true

		const service = await getCheckpointService(task, { interval: 10 })

		expect(service).toBeUndefined()
		expect(task.enableCheckpoints).toBe(false)
		expect(RepoPerTaskCheckpointService.create).not.toHaveBeenCalled()
		expect(provider?.postMessageToWebview).toHaveBeenCalledWith({
			type: "checkpointInitWarning",
			checkpointWarning: { type: "INIT_TIMEOUT", timeout: 0.05 },
		})
	})
})
