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
		expect(task.checkpointsDisabledByFailure).toBe(true)
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
