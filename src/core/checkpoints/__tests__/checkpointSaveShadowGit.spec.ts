// Contents assertions for checkpointSave against a real shadow git.
//
// The task-start baseline cases in src/core/task/__tests__/Task.spec.ts stub Task#checkpointSave
// (the spy at line 7181 resolves a commit, the one at 7451 resolves one empty save and then a
// commit, the one at 7476 resolves a commit) and assert how often the stub was called and with
// which flags. The checkpointSave cases in ./checkpoint.test.ts go one step further and stub the
// checkpoint service itself. Neither layer can show that the commit a save returns holds the
// workspace file's bytes: a save that staged the wrong worktree, recorded nothing, or committed
// bytes that had moved on would satisfy every call count and flag assertion above. This file runs
// the real RepoPerTaskCheckpointService over a real workspace git repo in a temporary directory
// and asserts the contents stored in the shadow git's own commits.

import fs from "fs/promises"
import os from "os"
import path from "path"

import { simpleGit } from "simple-git"

import { RepoPerTaskCheckpointService } from "../../../services/checkpoints"
import { BLOCKED_ENV_KEYS } from "../../../services/checkpoints/ShadowCheckpointService"

import { checkpointSave, getCheckpointService } from "../index"
import type { Task } from "../../task/Task"

// checkpointSave reports every recorded checkpoint through TelemetryService.instance; stubbing
// the client keeps the real telemetry upload wiring out of a contents test.
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

const tmpDir = path.join(os.tmpdir(), "checkpointSaveShadowGit")
const CHECKPOINTED_FILE = "checkpointed.txt"

// simple-git ≥3.36 blocks env vars it treats as code-execution vectors. Strip them for this
// suite so a developer's global GIT_EDITOR or GIT_SSH_COMMAND does not fail the real git calls
// below. Safe under vitest's default "forks" pool, where each worker owns its process.env.
const savedEnv: Partial<Record<string, string>> = {}

beforeAll(() => {
	for (const key of BLOCKED_ENV_KEYS) {
		savedEnv[key] = process.env[key]
		delete process.env[key]
	}
})

afterAll(async () => {
	for (const key of BLOCKED_ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key]
		} else {
			delete process.env[key]
		}
	}

	await fs.rm(tmpDir, { recursive: true, force: true })
}, 60_000)

/**
 * The read/write surface that checkpointSave and getCheckpointService actually touch:
 * the task identity and workspace, the checkpoint flags and timeout, the abort flag, the
 * provider used for logging and webview messages, and the say() the shadow service's
 * "checkpoint" event calls. A real Task would pull the whole extension host into a contents
 * test without adding any proof, so the double is cast once here rather than per case.
 */
type CheckpointSaveSurface = {
	taskId: string
	cwd: string
	enableCheckpoints: boolean
	checkpointService: RepoPerTaskCheckpointService | undefined
	checkpointServiceInitializing: boolean
	checkpointTimeout: number
	abort: boolean
	clineMessages: never[]
	apiConversationHistory: never[]
	say: (...args: unknown[]) => Promise<unknown>
	providerRef: {
		deref: () => {
			context: { globalStorageUri: { fsPath: string } }
			log: (message: string) => void
			postMessageToWebview: (message: unknown) => void
		}
	}
}

/**
 * checkpointSave resolves with a commit sha, resolves with nothing when the save found no changes
 * or the per-task queue dropped it, and returns void when no checkpoint service exists. Only the
 * first shape can hold recorded contents, so the other two are failures here.
 */
function committed(result: unknown, label: string): string {
	if (typeof result === "object" && result !== null && "commit" in result && typeof result.commit === "string") {
		return result.commit
	}

	throw new Error(`${label} resolved with no commit, so nothing was recorded in the shadow git`)
}

async function setupCheckpointTask(taskId: string) {
	const workspaceDir = path.join(tmpDir, `workspace-${taskId}`)
	const shadowDir = path.join(tmpDir, `storage-${taskId}`)
	await fs.mkdir(workspaceDir, { recursive: true })
	await fs.mkdir(shadowDir, { recursive: true })

	// A committed workspace state: the shadow git records its base commit from the workspace as it
	// stands at initialization, so the write under test has to land after that initialization for
	// its contents to be the delta the save is asked to record.
	const workspaceGit = simpleGit(workspaceDir)
	await workspaceGit.init()
	await workspaceGit.addConfig("user.name", "Roo Code")
	await workspaceGit.addConfig("user.email", "support@roocode.com")
	await workspaceGit.addConfig("commit.gpgSign", "false")
	await fs.writeFile(path.join(workspaceDir, CHECKPOINTED_FILE), "contents before the baseline")
	await workspaceGit.add(".")
	await workspaceGit.commit("record the workspace baseline")

	const surface: CheckpointSaveSurface = {
		taskId,
		cwd: workspaceDir,
		enableCheckpoints: true,
		checkpointService: undefined,
		checkpointServiceInitializing: false,
		checkpointTimeout: 30,
		abort: false,
		clineMessages: [],
		apiConversationHistory: [],
		say: vi.fn(async () => {}),
		providerRef: {
			deref: () => ({
				context: { globalStorageUri: { fsPath: shadowDir } },
				log: () => {},
				postMessageToWebview: vi.fn(),
			}),
		},
	}

	const task = surface as unknown as Task
	const service = await getCheckpointService(task)

	if (!service) {
		throw new Error("no checkpoint service after initialization, so no shadow git exists to read")
	}

	const baseHash = service.baseHash

	if (!baseHash) {
		throw new Error("the shadow git reported no base commit after initialization")
	}

	return { task, service, workspaceGit, baseHash }
}

describe("checkpointSave contents in a real shadow git", () => {
	it("records the written bytes in the commit the task-start baseline save returns", async () => {
		const { task, service, workspaceGit, baseHash } = await setupCheckpointTask("contents-at-baseline")

		// The write reaches the working tree only. The workspace repo never commits it, so the shadow
		// git is the single place the bytes can be recorded.
		await fs.writeFile(path.join(service.workspaceDir, CHECKPOINTED_FILE), "contents the baseline must record")

		// The same flags Task's baseline block uses: force (allow-empty) and suppressMessage.
		const commit = committed(await checkpointSave(task, true, true), "the task-start baseline save")

		const diffs = await service.getDiff({ from: baseHash, to: commit })
		expect(diffs).toHaveLength(1)
		expect(diffs[0].paths.relative).toBe(CHECKPOINTED_FILE)
		expect(diffs[0].content.before).toBe("contents before the baseline")
		expect(diffs[0].content.after).toBe("contents the baseline must record")

		// The workspace repo's own commit still holds the pre-write bytes, so the record above came
		// out of the shadow git and not out of the user-visible repository.
		expect(await workspaceGit.raw(["show", `HEAD:${CHECKPOINTED_FILE}`])).toBe("contents before the baseline")
	}, 30_000)

	it("keeps each save's own bytes: the second commit holds the second write and the first still holds the first", async () => {
		const { task, service, baseHash } = await setupCheckpointTask("contents-across-two-saves")
		const checkpointedFile = path.join(service.workspaceDir, CHECKPOINTED_FILE)

		await fs.writeFile(checkpointedFile, "first write")
		const commitOne = committed(await checkpointSave(task, false, true), "the first per-write save")

		await fs.writeFile(checkpointedFile, "second write")
		const commitTwo = committed(await checkpointSave(task, false, true), "the second per-write save")

		const baseToOne = await service.getDiff({ from: baseHash, to: commitOne })
		expect(baseToOne).toHaveLength(1)
		expect(baseToOne[0].content.before).toBe("contents before the baseline")
		expect(baseToOne[0].content.after).toBe("first write")

		const oneToTwo = await service.getDiff({ from: commitOne, to: commitTwo })
		expect(oneToTwo).toHaveLength(1)
		expect(oneToTwo[0].content.before).toBe("first write")
		expect(oneToTwo[0].content.after).toBe("second write")

		// Read the first commit again after the second save: the earlier record still holds its own
		// bytes. A call count says two saves happened; only the contents show that each one recorded
		// the state its caller asked for.
		const baseToOneAfterSecond = await service.getDiff({ from: baseHash, to: commitOne })
		expect(baseToOneAfterSecond[0].content.after).toBe("first write")

		const baseToTwo = await service.getDiff({ from: baseHash, to: commitTwo })
		expect(baseToTwo[0].content.after).toBe("second write")
	}, 30_000)

	it("records a file the workspace repo never tracked with the bytes it held when the save ran", async () => {
		const { task, service, workspaceGit, baseHash } = await setupCheckpointTask("contents-of-untracked-file")
		const newFile = path.join(service.workspaceDir, "written-by-the-tool.txt")
		await fs.writeFile(newFile, "the bytes a write handed to the workspace")

		const commit = committed(await checkpointSave(task, false, true), "the save after the new-file write")

		const diffs = await service.getDiff({ from: baseHash, to: commit })
		expect(diffs).toHaveLength(1)
		expect(diffs[0].paths.relative).toBe("written-by-the-tool.txt")
		expect(diffs[0].content.before).toBe("")
		expect(diffs[0].content.after).toBe("the bytes a write handed to the workspace")

		// Still untracked in the user's repository: the shadow git captured it, the workspace repo did
		// not, which is the difference the contents assertion is for.
		expect(await workspaceGit.raw(["status", "--porcelain"])).toContain("?? written-by-the-tool.txt")
	}, 30_000)
})
