// The in-flight half of review thread 607pkQ, against a real shadow git.
//
// 607pkQ asks that the in-flight baseline and any retry `preserve pre-write content or avoid
// publishing a baseline`. The per-task queue in ./index.ts guarantees ordering; it cannot guarantee
// content, because saveCheckpoint stages the workspace at the moment it executes. So a task-start
// baseline that is still running when the first write lands commits that write as the pre-task state,
// and the per-write save queued behind it then finds nothing to record. The baseline mislabels the
// bytes and the write costs no record of its own.
//
// This file asserts the branch the fix takes: once a write has landed, the in-flight baseline declines
// to publish at all - it resolves with no commit and costs the shadow git nothing - and the write
// keeps its own record whose diff base is the content the task started with.
import fs from "fs/promises"
import os from "os"
import path from "path"

import { simpleGit } from "simple-git"

import { RepoPerTaskCheckpointService } from "../../../services/checkpoints"
import { BLOCKED_ENV_KEYS } from "../../../services/checkpoints/ShadowCheckpointService"

import { checkpointSave, getCheckpointService } from "../index"
import type { Task } from "../../task/Task"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

const tmpDir = path.join(os.tmpdir(), "checkpointSaveContentPremise")
const CHECKPOINTED_FILE = "checkpointed.txt"
const PRE_WRITE = "content the task started with"
const MID_FLIGHT_WRITE = "the write that landed mid-flight"

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

type SaveArgs = Parameters<RepoPerTaskCheckpointService["saveCheckpoint"]>
type SaveReturn = Awaited<ReturnType<RepoPerTaskCheckpointService["saveCheckpoint"]>>

/**
 * Hold the first execution of saveCheckpoint before it stages anything, and hand back the release.
 * The held call is real shadow-git work once released, so what it stages is whatever the workspace
 * holds when it is released - which is the property this case turns on. The hold stands for the git
 * work a task-start baseline takes while the request loop moves on to the first write.
 */
function holdFirstSave(service: RepoPerTaskCheckpointService, tag: string) {
	const real = service.saveCheckpoint.bind(service)
	const calls: Array<{ stage: "requested" | "running"; tag: string }> = []
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let ordinal = 0

	service.saveCheckpoint = async (...args: SaveArgs): Promise<SaveReturn> => {
		const call = ordinal++
		// The held call is the baseline; anything after it is a save the baseline left behind, and the
		// list has to say which is which or the record below would be read against the wrong save.
		const label = call === 0 ? tag : "per-write"
		calls.push({ stage: "requested", tag: label })
		if (call === 0) {
			await held
		}
		calls.push({ stage: "running", tag: label })
		return real(...args)
	}

	return { calls, release }
}

async function commitCount(shadowDir: string, taskId: string): Promise<number> {
	const git = simpleGit(path.join(shadowDir, "tasks", taskId, "checkpoints"))
	const log = await git.log()
	return log.total
}

async function recorded(service: RepoPerTaskCheckpointService, from: string, to: string) {
	const diffs = await service.getDiff({ from, to })
	const file = diffs.find((d) => d.paths.relative === CHECKPOINTED_FILE)
	return { count: diffs.length, before: file?.content.before, after: file?.content.after }
}

type Setup = Awaited<ReturnType<typeof setupCheckpointTask>>

async function setupCheckpointTask(taskId: string): Promise<Setup> {
	const workspaceDir = path.join(tmpDir, `workspace-${taskId}`)
	const shadowDir = path.join(tmpDir, `storage-${taskId}`)
	await fs.mkdir(workspaceDir, { recursive: true })
	await fs.mkdir(shadowDir, { recursive: true })

	const workspaceGit = simpleGit(workspaceDir)
	await workspaceGit.init()
	await workspaceGit.addConfig("user.name", "Roo Code")
	await workspaceGit.addConfig("user.email", "support@roocode.com")
	await workspaceGit.addConfig("commit.gpgSign", "false")
	await fs.writeFile(path.join(workspaceDir, CHECKPOINTED_FILE), PRE_WRITE)
	await workspaceGit.add(".")
	await workspaceGit.commit("record the workspace the task started with")

	const task = {
		taskId,
		cwd: workspaceDir,
		enableCheckpoints: true,
		didEditFile: false,
		checkpointService: undefined as RepoPerTaskCheckpointService | undefined,
		checkpointServiceInitializing: false,
		checkpointTimeout: 30,
		abort: false,
		clineMessages: [] as never[],
		apiConversationHistory: [] as never[],
		say: vi.fn(async () => {}),
		providerRef: {
			deref: () => ({
				context: { globalStorageUri: { fsPath: shadowDir } },
				log: () => {},
				postMessageToWebview: vi.fn(),
			}),
		},
	} as unknown as Task

	const service = await getCheckpointService(task)

	if (!service) {
		throw new Error("no checkpoint service after initialization, so no shadow git exists to read")
	}

	return { task, service, workspaceGit, shadowDir, baseHash: service.baseHash }
}

describe("checkpointSave against a write that lands while the task-start baseline is in flight", () => {
	it("the baseline declines rather than publishing the write, and the write keeps its own record", async () => {
		const { task, service, shadowDir, baseHash } = await setupCheckpointTask("baseline-declines-after-a-write")
		const checkpointedFile = path.join(service.workspaceDir, CHECKPOINTED_FILE)

		// The shadow git was initialized from the workspace while it still held the pre-write content, so
		// that content is already recorded and the pair below can be read against it.
		const beforeBaseline = await commitCount(shadowDir, task.taskId)

		const { calls, release } = holdFirstSave(service, "baseline")
		// Requested while no agent write has happened: this save describes the workspace before the write.
		const baselinePromise = checkpointSave(task, true, true)
		await new Promise((resolve) => setTimeout(resolve, 25))
		expect(calls).toEqual([{ stage: "requested", tag: "baseline" }])

		// The write the thread names, landing while the baseline is still running: the bytes on disk, and
		// the flag every agent write path sets on the task.
		await fs.writeFile(checkpointedFile, MID_FLIGHT_WRITE)
		task.didEditFile = true
		release()

		const baseline = await baselinePromise
		const afterBaseline = await commitCount(shadowDir, task.taskId)

		// The baseline must not publish. It cannot record the state it was asked about, so it records
		// nothing, which is what the caller already treats as "no baseline yet" and retries against.
		expect(baseline).toBeUndefined()
		expect(afterBaseline).toBe(beforeBaseline)

		// The write then gets the record the drifted baseline would have swallowed: its own save, whose
		// diff base is the content the task started with.
		const writeSave = await checkpointSave(task, false, true)
		if (!writeSave || typeof writeSave !== "object" || !("commit" in writeSave) || typeof writeSave.commit !== "string") {
			throw new Error("the per-write save resolved with no commit, so the write has no record")
		}
		const writeCommit = writeSave.commit
		const record = await recorded(service, baseHash!, writeCommit)
		const afterWrite = await commitCount(shadowDir, task.taskId)

		// Both saves reached the shadow git and only one of them committed: the baseline was declined
		// at staging time and the write ran as its own save, in that order, because the queue held it there.
		expect(calls).toEqual([
			{ stage: "requested", tag: "baseline" },
			{ stage: "running", tag: "baseline" },
			{ stage: "requested", tag: "per-write" },
			{ stage: "running", tag: "per-write" },
		])
		expect(record.count).toBe(1)
		expect(record.before).toBe(PRE_WRITE)
		expect(record.after).toBe(MID_FLIGHT_WRITE)
		expect(afterWrite).toBe(beforeBaseline + 1)
	}, 60_000)
})
