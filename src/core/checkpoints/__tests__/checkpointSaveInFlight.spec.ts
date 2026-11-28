// The in-flight and retry halves of review thread 607pkQ, verified against a real shadow git.
//
// 607pkQ asks that `the in-flight baseline and any retry need to preserve pre-write content or avoid
// publishing a baseline` and that `the shared regression test can verify both cases`. The cases in
// ./checkpoint.test.ts prove the queue at the call level: its doubles show that a dropped save never
// reaches saveCheckpoint and that the warning names the reason. Neither layer can show what the shadow
// git ended up recording, which is what the thread is about: a save that published the wrong bytes, or
// a drop that silently cost a record, would satisfy every call-count assertion there.

// This file runs the real RepoPerTaskCheckpointService over a real workspace repo and asserts records,
// reusing the setup and the contents helper from ./checkpointSaveShadowGit.spec.ts.
import fs from "fs/promises"
import os from "os"
import path from "path"

import { simpleGit } from "simple-git"

import { RepoPerTaskCheckpointService } from "../../../services/checkpoints"
import { BLOCKED_ENV_KEYS } from "../../../services/checkpoints/ShadowCheckpointService"

import { checkpointRestore, checkpointSave, getCheckpointService } from "../index"
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

const tmpDir = path.join(os.tmpdir(), "checkpointSaveInFlight")
const CHECKPOINTED_FILE = "checkpointed.txt"

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
 * Hold the next execution of saveCheckpoint before it reaches the shadow git, and hand back the
 * release. The predecessor is real shadow-git work — the release runs the untouched implementation —
 * so what is staged is whatever the workspace holds when the call is released, which is the property
 * both cases turn on. The hold stands for a predecessor that outlives the next caller's checkpoint
 * window, which is the situation the expiry gate is for.
 */
function holdNextSave(service: RepoPerTaskCheckpointService, tag: string) {
	const real = service.saveCheckpoint.bind(service)
	const calls: Array<{ stage: "requested" | "running"; tag: string }> = []
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let holding = true

	service.saveCheckpoint = async (...args: SaveArgs): Promise<SaveReturn> => {
		if (holding) {
			holding = false
			calls.push({ stage: "requested", tag })
			await held
		}
		calls.push({ stage: "running", tag })
		return real(...args)
	}

	return { calls, release }
}

async function commitCount(shadowDir: string, taskId: string): Promise<number> {
	const git = simpleGit(path.join(shadowDir, "tasks", taskId, "checkpoints"))
	const log = await git.log()
	return log.total
}

// The return type is inferred, not aliased to Awaited<ReturnType<typeof itself>>: an alias that
// resolves through the function it annotates is circular and tsc rejects it (TS2456, TS2577).
async function setupCheckpointTask(taskId: string) {
	const workspaceDir = path.join(tmpDir, `workspace-${taskId}`)
	const shadowDir = path.join(tmpDir, `storage-${taskId}`)
	await fs.mkdir(workspaceDir, { recursive: true })
	await fs.mkdir(shadowDir, { recursive: true })

	const workspaceGit = simpleGit(workspaceDir)
	await workspaceGit.init()
	await workspaceGit.addConfig("user.name", "Roo Code")
	await workspaceGit.addConfig("user.email", "support@roocode.com")
	await workspaceGit.addConfig("commit.gpgSign", "false")
	await fs.writeFile(path.join(workspaceDir, CHECKPOINTED_FILE), "state before any agent write")
	await workspaceGit.add(".")
	await workspaceGit.commit("record the workspace baseline")

	const task = {
		taskId,
		cwd: workspaceDir,
		enableCheckpoints: true,
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
				cancelTask: vi.fn(),
			}),
		},
	} as unknown as Task

	const service = await getCheckpointService(task)

	if (!service) {
		throw new Error("no checkpoint service after initialization, so no shadow git exists to read")
	}

	return { task, service, workspaceGit, shadowDir, baseHash: service.baseHash }
}

async function recorded(service: RepoPerTaskCheckpointService, from: string, to: string) {
	const diffs = await service.getDiff({ from, to })
	const file = diffs.find((d) => d.paths.relative === CHECKPOINTED_FILE)
	return { count: diffs.length, after: file?.content.after }
}

describe("checkpointSave in-flight and retry against a real shadow git", () => {
	it("a save the expiry gate drops costs no record: the shadow git keeps exactly the earlier commits and the next save carries the moved-on bytes", async () => {
		const { task, service, shadowDir, baseHash } = await setupCheckpointTask("dropped-save-costs-no-record")
		const checkpointedFile = path.join(service.workspaceDir, CHECKPOINTED_FILE)

		// A baseline recorded while the workspace still holds its own state, so there is a known record
		// to compare the dropped save against.
		await fs.writeFile(checkpointedFile, "the state the baseline recorded")
		const baseline = await checkpointSave(task, true, true)

		if (
			!baseline ||
			typeof baseline !== "object" ||
			!("commit" in baseline) ||
			typeof baseline.commit !== "string"
		) {
			throw new Error("the baseline save resolved with no commit, so there is nothing to compare against")
		}

		// The predecessor is a real save held before it reaches the shadow git; the save behind it is
		// requested inside a checkpoint window shorter than the hold, so its turn arrives expired.
		const { release, calls } = holdNextSave(service, "predecessor")
		task.checkpointTimeout = 0.02
		const predecessor = checkpointSave(task, true, true)
		const queued = checkpointSave(task, false, true)
		const beforeDrop = await commitCount(shadowDir, task.taskId)

		await fs.writeFile(checkpointedFile, "bytes that arrived while the save waited")
		await new Promise((resolve) => setTimeout(resolve, 80))
		release()

		const dropped = await queued
		const settledPredecessor = await predecessor
		const afterDrop = await commitCount(shadowDir, task.taskId)

		// The dropped save ran no shadow-git work: the predecessor above it is the only entry that
		// reached the repository, and the commit count moved by that one and not by two.
		expect(calls).toEqual([
			{ stage: "requested", tag: "predecessor" },
			{ stage: "running", tag: "predecessor" },
		])
		expect(dropped).toBeUndefined()
		expect(afterDrop - beforeDrop).toBe(1)

		if (!settledPredecessor || typeof settledPredecessor !== "object" || !("commit" in settledPredecessor)) {
			throw new Error("the predecessor resolved with no commit, so there is no record to read")
		}
		const predecessorCommit = settledPredecessor.commit as string

		// The retry the thread asks about: a save requested after the stall settles gets its own turn in
		// spite of the entry the gate dropped above it, and it records the state that exists when it runs.
		// The drop therefore cost the shadow git no record it would have made correctly, and it cost the
		// queue nothing.
		task.checkpointTimeout = 30
		await fs.writeFile(checkpointedFile, "bytes the retry records")
		const retrySave = await checkpointSave(task, false, true)

		if (
			!retrySave ||
			typeof retrySave !== "object" ||
			!("commit" in retrySave) ||
			typeof retrySave.commit !== "string"
		) {
			throw new Error(
				"the save requested after the stall resolved with no commit, so the drop poisoned the queue",
			)
		}
		const afterRetry = await commitCount(shadowDir, task.taskId)
		const baselineRecord = await recorded(service, baseHash!, predecessorCommit)

		// The predecessor that did run staged what the workspace held when it was released, which is the
		// drift the other case is about; recorded here so the pair reads as measured rather than assumed.
		expect(baselineRecord.count).toBe(1)
		expect(baselineRecord.after).toBe("bytes that arrived while the save waited")
		const retryRecord = await recorded(service, predecessorCommit, retrySave.commit)
		expect(retryRecord.count).toBe(1)
		expect(retryRecord.after).toBe("bytes the retry records")
		expect(afterRetry - afterDrop).toBe(1)
	}, 60_000)

	// 4509635555 asks for the order these cases do not cover: not a save queued behind other work, but a
	// restore requested while a save is still in flight. The save has to finish first, because a restore
	// resets the workspace through the same shadow git, and a save that staged after it would record
	// the restored bytes instead of the write's own (src/core/checkpoints/index.ts:411-415 is the claim).
	it("a restore requested while a save is in flight waits for that save, so the save records the write and the restore lands after it", async () => {
		const { task, service, shadowDir } = await setupCheckpointTask("restore-queued-behind-in-flight-save")
		const checkpointedFile = path.join(service.workspaceDir, CHECKPOINTED_FILE)
		const order: string[] = []

		// The target the restore is asked to return to: a save that settles before any hold exists, so its
		// commit is a known state and the base of the diff assertions below.
		await fs.writeFile(checkpointedFile, "the state the restore returns to")
		const target = await checkpointSave(task, true, true)

		if (!target || typeof target !== "object" || !("commit" in target) || typeof target.commit !== "string") {
			throw new Error("the target save resolved with no commit, so there is nothing to restore to")
		}
		const targetCommit = target.commit

		// assertRecordedCheckpoint reads recorded hashes out of the conversation, and these cases drive the
		// service directly with suppressMessage, so the record is stated here rather than assumed.
		task.clineMessages.push({ say: "checkpoint_saved", text: targetCommit, ts: 1001 } as never)

		// The write whose checkpoint is at stake, then the save that must record it, held before it reaches
		// the shadow git so it is genuinely in flight when the restore is requested.
		await fs.writeFile(checkpointedFile, "bytes the in-flight save must record")
		const { calls, release } = holdNextSave(service, "in-flight save")

		const realRestore = service.restoreCheckpoint.bind(service)
		service.restoreCheckpoint = async (...args: Parameters<RepoPerTaskCheckpointService["restoreCheckpoint"]>) => {
			order.push("restore reached the shadow git")
			return realRestore(...args)
		}

		const inFlight = checkpointSave(task, false, true)

		// Wait on the observation rather than on a wall clock: the save is in flight once it has entered
		// saveCheckpoint and is standing in the hold, which makes it the queue's running entry.
		for (let waited = 0; waited < 5000 && calls.length === 0; waited += 20) {
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		expect(calls).toEqual([{ stage: "requested", tag: "in-flight save" }])

		const restore = checkpointRestore(task, { ts: 1001, commitHash: targetCommit, mode: "preview" })
		await new Promise((resolve) => setTimeout(resolve, 200))

		// While the save is held the restore has reached nothing: it is queued behind the save rather than
		// racing it through the same shadow git, and the workspace still holds the write's bytes.
		expect(order).toEqual([])
		expect(await fs.readFile(checkpointedFile, "utf8")).toBe("bytes the in-flight save must record")

		release()
		const saved = await inFlight
		await restore

		if (!saved || typeof saved !== "object" || !("commit" in saved) || typeof saved.commit !== "string") {
			throw new Error("the save behind the restore resolved with no commit, so it recorded nothing")
		}

		// The order the ask names, read from both sides: the save ran and recorded the write bytes, and the
		// restore only reached the shadow git after it.
		expect(order).toEqual(["restore reached the shadow git"])
		expect(calls).toEqual([
			{ stage: "requested", tag: "in-flight save" },
			{ stage: "running", tag: "in-flight save" },
		])
		const saveRecord = await recorded(service, targetCommit, saved.commit)
		expect(saveRecord.count).toBe(1)
		expect(saveRecord.after).toBe("bytes the in-flight save must record")
		expect(await fs.readFile(checkpointedFile, "utf8")).toBe("the state the restore returns to")
		// A restore resets the workspace by moving the shadow git's HEAD back to the commit it restores to,
		// so the save's own commit stops being reachable from HEAD even though it still exists by hash: HEAD
		// is named here because counting commits from HEAD would read the restore's reset as the save having
		// added nothing.
		const headAfterRestore = (
			await simpleGit(path.join(shadowDir, "tasks", task.taskId, "checkpoints")).log({ maxCount: 1 })
		).latest?.hash
		expect(headAfterRestore).toBe(targetCommit)
	}, 60_000)
})
