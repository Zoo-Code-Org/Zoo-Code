/**
 * Mutation-gap tests for the guarded-write compare-and-swap core (upstream epic #1375).
 *
 * Every row here was written against a surviving or uncovered mutant that
 * scripts/stryker-diff.mjs reported on the changed lines of src/core/tools/guardedWrite.ts,
 * so the assertions aim at the behaviour the earlier suite left unproven instead of restating
 * a verdict it already carried: the per-path chain tail, the cancellation gates and
 * cancellation closures inside the publish helpers, the committed-token recording after a
 * durability failure, the target and ancestor pin re-checks taken under the lock, and the
 * completeness a refresh carries.
 */

import * as fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { createIfAbsent, guardedWrite, replaceIfVersion, resetChain, GuardRejectedError } from "../guardedWrite"
import { PostCommitDurabilityError, safeWriteText } from "../../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../../utils/versionToken"
import { withFileLock } from "../../../utils/fileLock"
import { resolveLockKey } from "../../../services/file-safety/safeWriteText"
import { ObservationRegistry } from "../../task/observationRegistry"
import type { Task } from "../../task/Task"
import { initialRunState } from "../../task/run-state/runState"
import { setAbortLatch } from "../../../test-utils/run-state"

vi.mock("fs/promises", () => ({
	access: vi.fn(),
	stat: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
	mkdir: vi.fn(),
}))

vi.mock("../../../utils/versionToken", () => ({
	computeVersionToken: vi.fn(),
}))

vi.mock("../../../services/file-safety/safeWriteText", async (importOriginal) => {
	// The error classes keep their production identity: the guard decides a publish failure by
	// instanceof, so a doubled class would decide a different question.
	const actual = await importOriginal<typeof import("../../../services/file-safety/safeWriteText")>()
	return {
		...actual,
		safeWriteText: vi.fn(),
		resolveLockKey: vi.fn(async (p: string) => p),
	}
})

vi.mock("../../../utils/fileLock", () => ({
	withFileLock: vi.fn(),
}))

const mockedWithFileLock = vi.mocked(withFileLock)
const mockedResolveLockKey = vi.mocked(resolveLockKey)
const mockedFsAccess = vi.mocked(fs.access)
const mockedFsRealpath = vi.mocked(fs.realpath)
const mockedFsLstat = vi.mocked(fs.lstat)
const mockedFsStat = vi.mocked(fs.stat)
const mockedFsMkdir = vi.mocked(fs.mkdir)
const mockedComputeVersionToken = vi.mocked(computeVersionToken)
const mockedSafeWriteText = vi.mocked(safeWriteText)

const WORKSPACE = "/test/workspace"

/** Resolve a fixture path the same way guardedWrite resolves task.cwd-relative paths. */
const abs = (relPath: string): string => path.resolve(WORKSPACE, relPath)

/** A Node errno carrying error, for the codes the guard branches on. */
function errno(code: string): Error {
	return Object.assign(new Error(code), { code })
}

/**
 * BigIntStats double for the ancestor identity pin. BigIntStats is class backed with no public
 * constructor and the guard reads only dev and ino, so this is a last-resort double assertion
 * (test-local, per AGENTS.md).
 */
function dirStat(dev: bigint, ino: bigint): BigIntStats {
	return { dev, ino } as unknown as BigIntStats
}

/** Narrow an unknown thrown value to the guard verdict, failing loudly otherwise. */
function asGuardRejection(thrown: unknown): GuardRejectedError {
	if (thrown instanceof GuardRejectedError) {
		return thrown
	}
	throw new Error("expected a guard rejection, got " + String(thrown))
}

interface MockTaskOptions {
	cwd?: string
	observationRegistry?: ObservationRegistry
	abort?: boolean
}

/**
 * Minimal structural Task: guardedWrite reads task.cwd, task.abort,
 * task.cancellationGeneration and task.observationRegistry. The real Task constructor needs the
 * whole provider machinery, so one documented double cast stands in for the class.
 */
function createMockTask(options: MockTaskOptions = {}): Task {
	const task = {
		cwd: options.cwd ?? WORKSPACE,
		runState: initialRunState,
		// The guard reads cancellation through task.abort. On a real task that is the run-state
		// getter (RSK-06), so the double mirrors the same latch the kernel owns rather than
		// carrying a separate writable flag the kernel has dropped.
		get abort(): boolean {
			return this.runState.latches.abort
		},
		cancellationGeneration: 0,
		observationRegistry: options.observationRegistry ?? new ObservationRegistry(),
	}
	setAbortLatch(task, options.abort ?? false)
	return task as unknown as Task
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Bounded poll: reports whether the condition became true within the limit. */
async function waitUntil(condition: () => boolean, limitMs: number): Promise<boolean> {
	const deadline = Date.now() + limitMs
	while (!condition() && Date.now() < deadline) {
		await delay(5)
	}
	return condition()
}

/**
 * A cancellation stub answering a scripted sequence, so a gate can be caught at exactly one
 * point in a publish without relying on wall-clock timing. Once the sequence runs out the stub
 * keeps answering with its last value.
 */
function cancelScript(sequence: boolean[]): () => boolean {
	let asked = 0
	return () => {
		const answer = asked < sequence.length ? sequence[asked] : sequence[sequence.length - 1]
		asked += 1
		return answer
	}
}

/** Hold a promise open until its release function is called. */
function heldGate(): { wait: Promise<void>; release: () => void } {
	let release!: () => void
	const wait = new Promise<void>((resolve) => {
		release = resolve
	})
	return { wait, release }
}

/**
 * Flips the task inside the publish helper's own resolveLockKey await. That await is the last
 * one before the helper's first cancellation gate, so the flip lands after the chain dequeue
 * check has already passed and only the closure handed to this helper can still refuse the
 * publish.
 */
function flipInsideLockKey(task: Task, flip: (target: Task) => void): void {
	mockedResolveLockKey.mockImplementation(async (p: string) => {
		flip(task)
		return String(p)
	})
}

const CANCELLED_BEFORE_PUBLISH = "Task was cancelled before this write published -- nothing was written."

describe("guardedWrite mutation gaps (epic #1375)", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mockedWithFileLock.mockImplementation((filePath, operation) => operation(path.resolve(filePath)))
		mockedFsRealpath.mockImplementation(async (p) => String(p))
		mockedFsLstat.mockRejectedValue(errno("ENOENT"))
		mockedFsStat.mockRejectedValue(errno("ENOENT"))
		mockedFsMkdir.mockResolvedValue(undefined)
		resetChain()
	})

	describe("per-path chain tail ownership", () => {
		// A link deletes the map entry only while that entry is still the tail for its path. A
		// cleanup that deletes whatever the map holds, or that compares against the wrong promise,
		// drops an entry a later write already owns, and that write then overtakes the one still
		// publishing. The earlier link has to settle while the later write is already queued, so the
		// FIRST write is the gated one here: gating only the second lets the first entry settle and
		// clean up before the second write ever reaches the chain, which is a run in which deleting
		// too eagerly changes nothing. The observable is the third write's start: it must not begin
		// while the second write is still in flight.
		it("keeps a third write queued behind the write still in flight while an earlier link settles", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			const published: string[] = []
			const firstWriteGate = heldGate()
			const secondWriteGate = heldGate()
			mockedSafeWriteText.mockImplementation(async (filePath, content) => {
				published.push(String(content))
				if (content === "first") {
					await firstWriteGate.wait
				}
				if (content === "second") {
					await secondWriteGate.wait
				}
			})
			const task = createMockTask()

			const firstWrite = guardedWrite(task, "chain.txt", "first", "create")
			expect(await waitUntil(() => published.includes("first"), 500)).toBe(true)
			// The second write queues behind the first while the first still holds the chain.
			const secondWrite = guardedWrite(task, "chain.txt", "second", "create")

			// Releasing the first publish lets the first link settle while the second write is
			// mid-publish, so the tail entry in the per-path map belongs to the second write.
			firstWriteGate.release()
			expect(await waitUntil(() => published.includes("second"), 500)).toBe(true)
			await firstWrite
			const thirdWrite = guardedWrite(task, "chain.txt", "third", "create")
			await delay(40)
			expect(published).toEqual(["first", "second"])

			secondWriteGate.release()
			await Promise.all([secondWrite, thirdWrite])
			expect(published).toEqual(["first", "second", "third"])
		})

		it("keeps a third write queued behind the write still in flight while an earlier link is rejected", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			const ioFailure = errno("EIO")
			const published: string[] = []
			const firstWriteGate = heldGate()
			const secondWriteGate = heldGate()
			mockedSafeWriteText.mockImplementation(async (filePath, content) => {
				published.push(String(content))
				if (content === "first") {
					await firstWriteGate.wait
					throw ioFailure
				}
				if (content === "second") {
					await secondWriteGate.wait
				}
			})
			const task = createMockTask()

			const firstWrite = guardedWrite(task, "chain.txt", "first", "create")
			// Attaching the failure handler now keeps this callers rejection handled while the later
			// writes are queued: each caller receives its own link promise to handle.
			const firstOutcome = firstWrite.catch((error: unknown) => error)
			expect(await waitUntil(() => published.includes("first"), 500)).toBe(true)
			const secondWrite = guardedWrite(task, "chain.txt", "second", "create")

			// A rejected link is skipped, not propagated, so the second write keeps publishing while
			// the first one fails. Releasing the first publish makes that first link reject while the
			// second is mid-publish, so the tail entry the rejection cleanup must leave alone belongs
			// to the second write.
			firstWriteGate.release()
			expect(await waitUntil(() => published.includes("second"), 500)).toBe(true)
			expect(await firstOutcome).toBe(ioFailure)
			const thirdWrite = guardedWrite(task, "chain.txt", "third", "create")
			await delay(40)
			expect(published).toEqual(["first", "second"])

			secondWriteGate.release()
			await Promise.all([secondWrite, thirdWrite])
			expect(published).toEqual(["first", "second", "third"])
		})
	})

	describe("cancellation gates inside the publish helpers", () => {
		it("reports cancellation rather than the already-exists verdict when the task was cancelled over an existing target", async () => {
			mockedFsAccess.mockResolvedValue(undefined)

			const thrown = await createIfAbsent(abs("here.txt"), "data", "here.txt", () => true).catch(
				(error: unknown) => error,
			)

			// A create that finds the target on disk ends in the read-first verdict, so dropping the
			// gate above hands the caller that verdict instead of the cancellation the caller already
			// reported to the model.
			expect(asGuardRejection(thrown).message).toBe(CANCELLED_BEFORE_PUBLISH)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("re-checks cancellation after the absence probe and publishes nothing", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))

			await expect(
				createIfAbsent(abs("gone.txt"), "data", "gone.txt", cancelScript([false, true])),
			).rejects.toThrow(CANCELLED_BEFORE_PUBLISH)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("reports cancellation rather than a raw errno when the task was cancelled before the preflight", async () => {
			const ioFailure = errno("EACCES")
			mockedComputeVersionToken.mockRejectedValue(ioFailure)

			const thrown = await replaceIfVersion(abs("doc.txt"), "v1", "patched", "doc.txt", () => true).catch(
				(error: unknown) => error,
			)

			// Without this gate the preflight runs anyway and the caller receives the errno below,
			// which is not a guard verdict and carries no remediation.
			expect(thrown).toBeInstanceOf(GuardRejectedError)
			expect(thrown).not.toBe(ioFailure)
			expect(asGuardRejection(thrown).message).toContain("Task was cancelled before this write published")
			expect(asGuardRejection(thrown).name).toBe("GuardRejectedError")
		})

		it("re-checks cancellation after the awaited preflight and publishes nothing", async () => {
			mockedComputeVersionToken.mockResolvedValue("v1")

			await expect(
				replaceIfVersion(abs("doc.txt"), "v1", "patched", "doc.txt", cancelScript([false, true, false])),
			).rejects.toThrow(CANCELLED_BEFORE_PUBLISH)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("re-checks cancellation immediately before the publish and publishes nothing", async () => {
			mockedComputeVersionToken.mockResolvedValue("v1")

			await expect(
				replaceIfVersion(abs("doc.txt"), "v1", "patched", "doc.txt", cancelScript([false, false, true])),
			).rejects.toThrow(CANCELLED_BEFORE_PUBLISH)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("spells the deleted-after-read remediation in full", async () => {
			mockedComputeVersionToken.mockRejectedValue(errno("ENOENT"))

			const thrown = await replaceIfVersion(abs("doc.txt"), "v1", "patched", "doc.txt").catch(
				(error: unknown) => error,
			)

			// The suffix is the part the model can act on: a message that stops at the fact tells the
			// caller nothing about what to do next.
			expect(asGuardRejection(thrown).message).toBe(
				"File was deleted after it was read -- the version recorded at read time (v1) no longer exists; re-read the file, then retry.",
			)
		})
	})

	describe("committed token and durability failure", () => {
		it("records the token read under the lock when a create commits and then fails its durability sync", async () => {
			const reg = new ObservationRegistry()
			const task = createMockTask({ observationRegistry: reg })
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			let lockHeld = false
			mockedWithFileLock.mockImplementation((filePath, operation) => {
				lockHeld = true
				return (async () => {
					try {
						return await operation(path.resolve(String(filePath)))
					} finally {
						// The lock is off this write from here on, on both paths: the value the
						// operation returned and the failure the publish raised.
						lockHeld = false
					}
				})()
			})
			mockedComputeVersionToken.mockImplementation(async () =>
				lockHeld ? "committed-under-lock" : "peer-writer-token",
			)
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("fresh.txt"), errno("EIO")))

			await expect(guardedWrite(task, "fresh.txt", "data", "create")).rejects.toThrow(PostCommitDurabilityError)

			// The token in the observation has to be the one this publish committed. Numbering the
			// reads would not prove it: without the capture under the lock the read taken after the
			// release simply takes the same slot and inherits a peer's value. The answer above is a
			// function of the lock mock's own held state, so only the under-lock read can give it.
			expect(reg.get(abs("fresh.txt"))?.version).toBe("committed-under-lock")
		})

		it("does not read a token for a publish failure that committed nothing", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValue("v1")
			mockedSafeWriteText.mockRejectedValue(errno("EACCES"))

			await expect(guardedWrite(task, "doc.txt", "patched", "update")).rejects.toThrow("EACCES")

			// Exactly one token read belongs to this flow: the pre-write comparison. A second read
			// would be taken for an error that committed nothing, and its value would stand for a
			// publish that never happened.
			expect(mockedComputeVersionToken).toHaveBeenCalledTimes(1)
			expect(reg.get(abs("doc.txt"))?.version).toBe("v1")
		})

		it("leaves the observation alone when a durability failure cannot report a committed token", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockImplementation(async () => {
				throw errno("EIO")
			})
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("doc.txt"), errno("EIO")))

			await expect(guardedWrite(task, "doc.txt", "patched", "edit")).rejects.toThrow(PostCommitDurabilityError)

			// The file on disk now holds content whose version this write never learned. Recording an
			// unknown value as this write's own token would authorize the next write against a
			// version the task was never shown.
			expect(reg.get(abs("doc.txt"))?.version).toBe("v1")
		})

		it("does not refresh from a token read taken after the lock is released", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			const task = createMockTask({ observationRegistry: reg })
			// Three answers in order: the pre-write comparison, the read this publish makes while it
			// still holds the lock - which fails here, so nothing is recorded - and the value a read
			// taken after the release would report, when a peer can have published in the gap.
			mockedComputeVersionToken
				.mockResolvedValueOnce("v1")
				.mockRejectedValueOnce(errno("EIO"))
				.mockResolvedValue("peer-writer-token")
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("doc.txt"), errno("EIO")))

			await expect(guardedWrite(task, "doc.txt", "patched", "edit")).rejects.toThrow(PostCommitDurabilityError)

			// Two token reads belong to this flow: the comparison and the under-lock read that failed.
			// The third read is the one taken outside the lock, and its value would stand for a publish
			// this write never measured, which is the mistake the record under the lock exists to avoid.
			expect(mockedComputeVersionToken).toHaveBeenCalledTimes(2)
			expect(reg.get(abs("doc.txt"))?.version).toBe("v1")
		})

		it("keeps a partial observation partial when a durability failure refreshes it", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValue("committed-under-lock")
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("doc.txt"), errno("EIO")))

			await expect(guardedWrite(task, "doc.txt", "patched", "edit", true)).rejects.toThrow(
				PostCommitDurabilityError,
			)

			expect(reg.get(abs("doc.txt"))?.version).toBe("committed-under-lock")
			expect(reg.get(abs("doc.txt"))?.complete).toBe(false)
		})

		it("records a durability-failure refresh as complete when nothing narrowed the view", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValue("committed-under-lock")
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("doc.txt"), errno("EIO")))

			await expect(guardedWrite(task, "doc.txt", "patched", "edit")).rejects.toThrow(PostCommitDurabilityError)

			// The edit replaced content the task had read in full, so the refreshed observation is a
			// complete read of the new file. Leaving it partial would make a later full-file
			// replacement ask for a re-read of content the task had just written.
			expect(reg.get(abs("doc.txt"))?.complete).toBe(true)
		})

		it("carries a caller's narrow completeness through a durability-failure refresh", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValue("committed-under-lock")
			mockedSafeWriteText.mockRejectedValue(new PostCommitDurabilityError(abs("doc.txt"), errno("EIO")))

			await expect(guardedWrite(task, "doc.txt", "patched", "edit", false)).rejects.toThrow(
				PostCommitDurabilityError,
			)

			expect(reg.get(abs("doc.txt"))?.complete).toBe(false)
		})

		it("rethrows a publish failure that is neither a durability failure nor a collision", async () => {
			const task = createMockTask()
			const ioFailure = Object.assign(new Error("directory unreadable"), { code: "EACCES" })
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedSafeWriteText.mockRejectedValue(ioFailure)

			const thrown = await guardedWrite(task, "new.txt", "data", "create").catch((error: unknown) => error)

			// The read-first verdict belongs to a collision. Reporting an unreadable directory as a
			// file that still has to be read sends the model off to read a file it cannot even stat.
			expect(thrown).toBe(ioFailure)
			expect(thrown).not.toBeInstanceOf(GuardRejectedError)
		})
	})

	describe("target and ancestor pin re-checks under the lock", () => {
		it("refuses the publish when the resolved target moved between the containment check and the commit", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			let targetLookups = 0
			mockedFsRealpath.mockImplementation(async (p) => {
				const spelled = String(p)
				if (spelled === path.resolve(WORKSPACE)) {
					return spelled
				}
				targetLookups += 1
				// The second resolution is the one the publish helper re-runs under the lock. It
				// answers with a different file, so the decision the guard recorded was made about a
				// different file than the one about to be written.
				return targetLookups === 1 ? abs("moved.txt") : abs("other-place.txt")
			})
			const task = createMockTask()

			const thrown = await guardedWrite(task, "moved.txt", "data", "create").catch((error: unknown) => error)

			expect(asGuardRejection(thrown).message).toBe(
				"Path changed between the containment check and the publish -- nothing was written.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("stats the authorized directories with bigint inode arithmetic", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			mockedFsStat.mockImplementation(async (p) => {
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) {
					return dirStat(1n, 100n)
				}
				if (dir === abs("nested")) {
					return dirStat(1n, 200n)
				}
				throw errno("ENOENT")
			})
			const task = createMockTask()

			await guardedWrite(task, "nested/in.txt", "data", "create")

			// Inode numbers above 2^53 are ordinary on network filesystems, and a stat without the
			// bigint option rounds them, so two different directories can compare equal and a
			// replaced ancestor passes the pin.
			expect(mockedFsStat).toHaveBeenCalledWith(abs("nested"), { bigint: true })
			expect(mockedFsStat).toHaveBeenCalledWith(path.resolve(WORKSPACE), { bigint: true })
		})

		it("refuses the publish when only the device number of an authorized directory changed", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			let nestedStats = 0
			mockedFsStat.mockImplementation(async (p) => {
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) {
					return dirStat(1n, 100n)
				}
				if (dir === abs("nested")) {
					nestedStats += 1
					// The third stat of this directory is the one the publish helper takes against the
					// identities it recorded. The device differs while the inode stays the same, so
					// only the device comparison can notice this replacement.
					return nestedStats >= 3 ? dirStat(2n, 200n) : dirStat(1n, 200n)
				}
				throw errno("ENOENT")
			})
			const task = createMockTask()

			const thrown = await guardedWrite(task, "nested/in.txt", "data", "create").catch((error: unknown) => error)

			expect(asGuardRejection(thrown).message).toContain(
				"A directory on the authorized path was replaced after this write was checked",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses the publish when only the inode of an authorized directory changed", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			let nestedStats = 0
			mockedFsStat.mockImplementation(async (p) => {
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) {
					return dirStat(1n, 100n)
				}
				if (dir === abs("nested")) {
					nestedStats += 1
					return nestedStats >= 3 ? dirStat(1n, 300n) : dirStat(1n, 200n)
				}
				throw errno("ENOENT")
			})
			const task = createMockTask()

			const thrown = await guardedWrite(task, "nested/in.txt", "data", "create").catch((error: unknown) => error)

			expect(asGuardRejection(thrown).message).toContain(
				"A directory on the authorized path was replaced after this write was checked",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses the publish when an authorized directory has been removed", async () => {
			mockedFsAccess.mockRejectedValue(errno("ENOENT"))
			mockedComputeVersionToken.mockResolvedValue("v1")
			let nestedStats = 0
			mockedFsStat.mockImplementation(async (p) => {
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) {
					return dirStat(1n, 100n)
				}
				if (dir === abs("nested")) {
					nestedStats += 1
					if (nestedStats >= 3) {
						throw errno("ENOENT")
					}
					return dirStat(1n, 200n)
				}
				throw errno("ENOENT")
			})
			const task = createMockTask()

			const thrown = await guardedWrite(task, "nested/in.txt", "data", "create").catch((error: unknown) => error)

			// The directory this write was authorized against is gone, so the name now sits inside
			// some other directory. A raw errno would not tell the model what to redo.
			expect(thrown).toBeInstanceOf(GuardRejectedError)
			expect(asGuardRejection(thrown).message).toContain(
				"A directory on the authorized path was replaced after this write was checked",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("the default write kind", () => {
		it("takes the replacement path, not the create path, when the caller names no kind", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "hello")

			// The default has to be the full-file replacement: it compares the recorded version and
			// publishes without the no-replace guard a create carries, so an existing target is
			// replaced only when the version the task read still matches the one on disk.
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "hello", {
				expectedResolvedPath: abs("doc.txt"),
				expectedAncestorIdentities: [],
			})
			expect(mockedComputeVersionToken).toHaveBeenCalledTimes(2)
		})
	})

	describe("cancellation closures handed to the publish helpers", () => {
		const abortOnly = (target: Task): void => {
			setAbortLatch(target, true)
		}
		const generationOnly = (target: Task): void => {
			// The other half of the fence: the latch stays as a resume left it, so only the captured
			// generation can see this cancel.
			target.cancellationGeneration += 1
		}
		const flavors: { label: string; flip: (target: Task) => void }[] = [
			{ label: "aborted inside the helper", flip: abortOnly },
			{ label: "generation advanced inside the helper", flip: generationOnly },
		]
		const cases: { label: string; kind: "edit" | "update" | "create"; observed: boolean }[] = [
			{ label: "targeted edit", kind: "edit", observed: true },
			{ label: "full-file replacement", kind: "update", observed: true },
			{ label: "create the task never read", kind: "create", observed: false },
			{ label: "create over a target that vanished after the read", kind: "create", observed: true },
		]

		cases.forEach((testCase) => {
			flavors.forEach((flavor) => {
				it("stops the " + testCase.label + " path when the task is " + flavor.label, async () => {
					const reg = new ObservationRegistry()
					if (testCase.observed) {
						reg.observe(abs("doc.txt"), "v1", true)
					}
					mockedComputeVersionToken.mockResolvedValue("v1")
					mockedFsAccess.mockRejectedValue(errno("ENOENT"))
					const task = createMockTask({ observationRegistry: reg })
					flipInsideLockKey(task, flavor.flip)

					await expect(guardedWrite(task, "doc.txt", "patched", testCase.kind)).rejects.toThrow(
						CANCELLED_BEFORE_PUBLISH,
					)

					// The flip lands after the chain dequeue check passed, so this closure is the only
					// cancellation decision left that can refuse the publish: a closure that misses it
					// lets a cancelled task write the file and read a token for it.
					expect(mockedSafeWriteText).not.toHaveBeenCalled()
					expect(mockedComputeVersionToken).not.toHaveBeenCalled()
				})
			})
		})
	})
})
