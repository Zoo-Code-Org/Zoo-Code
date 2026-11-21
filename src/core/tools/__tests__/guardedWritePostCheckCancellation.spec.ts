/**
 * Post-check cancellation gaps for the guarded-write core (upstream epic #1375).
 *
 * Every row here aims at a mutant that scripts/stryker-diff.mjs reported as Survived on the
 * changed lines of src/core/tools/guardedWrite.ts: the cancellation gate at line 690, which runs
 * after the containment re-check and before this write's publish is handed to the chain. The
 * dequeue gate inside the publish, line 712, already has rows of its own in
 * guardedWriteMutationGaps.spec.ts, and on its own it reports the same verdict with the same
 * message. What no row covered is the difference between refusing now and refusing later: a
 * refused publish must not take its turn on the path's FIFO chain behind a publish that is live.
 */

import * as fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { guardedWrite, resetChain, GuardRejectedError } from "../guardedWrite"
import { safeWriteText } from "../../../services/file-safety/safeWriteText"
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
 * BigIntStats double for one directory's identity. BigIntStats is a class backed with no public
 * constructor and the guard reads only dev, ino and the request options, so this is a last-resort
 * double assertion (test-local, per AGENTS.md).
 */
function statsDouble(dev: bigint, ino: bigint, bigint: boolean): BigIntStats {
	const wide = bigint ? dev : BigInt.asIntN(48, dev)
	const wideIno = bigint ? ino : BigInt.asIntN(48, ino)
	return { dev: wide, ino: wideIno } as unknown as BigIntStats
}

/** Reads the bigint flag off the options object a stat or lstat request carried. */
function hasBigIntFlag(options: unknown): boolean {
	return (
		typeof options === "object" &&
		options !== null &&
		"bigint" in options &&
		(options as { bigint?: unknown }).bigint === true
	)
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Answer {
	/** The verdict this caller received, plus the publish bookkeeping at the moment it arrived. */
	settled: Promise<{ outcome: string; publishFinishedAtAnswer: boolean; publishOpenAtAnswer: boolean }>
}

/** Record a guardedWrite verdict together with the publish bookkeeping when it arrives. */
function recordAnswer(write: Promise<unknown>): Answer {
	return {
		settled: write.then(
			() => ({
				outcome: "published",
				publishFinishedAtAnswer: publishFinished,
				publishOpenAtAnswer: publishOpen,
			}),
			(error: unknown) => ({
				outcome: "rejected",
				publishFinishedAtAnswer: publishFinished,
				publishOpenAtAnswer: publishOpen,
				rejection: error,
			}),
		) as Promise<{ outcome: string; publishFinishedAtAnswer: boolean; publishOpenAtAnswer: boolean }>,
	}
}

/** A promise plus the two functions that settle it, for holding a publish open on purpose. */
interface Gate {
	promise: Promise<void>
	open: () => void
}

function gate(): Gate {
	let open!: () => void
	const promise = new Promise<void>((resolve) => {
		open = () => {
			resolve()
		}
	})
	return { promise, open }
}

/** Narrow an unknown thrown value to the guard verdict, failing loudly otherwise. */
function asGuardRejection(thrown: unknown): GuardRejectedError {
	if (thrown instanceof GuardRejectedError) {
		return thrown
	}
	throw new Error("expected a guard rejection, got " + String(thrown))
}

interface CancellableTask {
	task: Task
	/** Runs the run-state abort latch the same way requestAbort() does. */
	abortNow: () => void
	/** Advances the cancellation fence the same way requestAbort() and requestDispose() do. */
	moveGenerationNow: () => void
}

/**
 * Minimal structural Task: guardedWrite reads task.cwd, task.abort, task.cancellationGeneration
 * and task.observationRegistry. The real Task constructor needs the whole provider machinery, so
 * one documented double cast stands in for the class. The unwrapped double is returned too, so a
 * test can move the fence through the object rather than through the readonly view.
 */
function createCancellableTask(): CancellableTask {
	const task = {
		cwd: WORKSPACE,
		runState: initialRunState,
		// The guard reads cancellation through task.abort. On a real task that is the run-state
		// getter (RSK-06), so the double mirrors the same latch the kernel owns rather than
		// carrying a separate writable flag the kernel has dropped.
		get abort(): boolean {
			return this.runState.latches.abort
		},
		cancellationGeneration: 0,
		observationRegistry: new ObservationRegistry(),
	}
	return {
		task: task as unknown as Task,
		abortNow: () => {
			setAbortLatch(task, true)
		},
		moveGenerationNow: () => {
			task.cancellationGeneration += 1
		},
	}
}

const CANCELLED = "Task was cancelled before this write ran -- the queued publish is not performed."

/** Live publish bookkeeping: whether a publish is open, and whether one has finished. */
let publishOpen = false
let publishFinished = false
let release: Gate

/** Wait until the doubled writer has been entered, so a test knows a publish is genuinely open. */
async function waitUntilOpen(): Promise<void> {
	const deadline = Date.now() + 500
	while (!publishOpen && Date.now() < deadline) {
		await delay(5)
	}
	if (!publishOpen) {
		throw new Error("the doubled writer never opened, so nothing was holding the path's chain")
	}
}

describe("guardedWrite post-check cancellation gaps (epic #1375)", () => {
	/** Move the cancellation fact on the first filesystem request the next check makes. */
	function flipOnNextCheck(flip: () => void): void {
		let flipped = false
		mockedFsRealpath.mockImplementation(async (p: unknown) => {
			const key = String(p)
			if (!flipped && key === abs(".")) {
				flipped = true
				flip()
			}
			return key
		})
	}

	beforeEach(() => {
		vi.resetAllMocks()
		publishOpen = false
		publishFinished = false
		release = gate()
		mockedWithFileLock.mockImplementation((filePath, operation) => operation(path.resolve(filePath)))
		mockedResolveLockKey.mockImplementation(async (p: string) => p)
		mockedFsAccess.mockRejectedValue(errno("ENOENT"))
		mockedFsMkdir.mockResolvedValue(undefined)
		mockedComputeVersionToken.mockResolvedValue("v1")
		mockedSafeWriteText.mockImplementation(async () => {
			publishOpen = true
			await release.promise
			publishOpen = false
			publishFinished = true
		})
		mockedFsStat.mockImplementation(async (p: unknown, options?: unknown) => {
			const key = String(p)
			if (key !== abs(".")) {
				throw errno("ENOENT")
			}
			return statsDouble(7n, 7001n, hasBigIntFlag(options))
		})
		vi.mocked(fs.lstat).mockImplementation(async () => {
			throw errno("ENOENT")
		})
		mockedFsRealpath.mockImplementation(async (p: unknown) => String(p))
		resetChain()
	})

	describe("the gate between the containment re-check and the queued publish", () => {
		it("refuses a write the abort latch cancelled during its re-check", async () => {
			const holder = createCancellableTask()
			const held = guardedWrite(holder.task, "new.txt", "data", "create").catch((error: unknown) => error)
			await waitUntilOpen()

			// One publish is open on this path and its link is on the chain. This write was submitted
			// after it, with the latch down, and the latch moves while the containment re-check runs.
			const canceller = createCancellableTask()
			flipOnNextCheck(canceller.abortNow)
			const answer = recordAnswer(guardedWrite(canceller.task, "new.txt", "data", "create"))
			release.open()
			await held
			const settled = await answer.settled

			expect(asGuardRejection((settled as { rejection?: unknown }).rejection).message).toBe(CANCELLED)
			// The refused write never reached the writer, and its answer arrived only once its own turn
			// on the chain came round, which is after the live publish had settled: this caller's promise
			// IS its chain entry (guardedWrite.ts line 148), so releasing the reserved place cannot deliver
			// the verdict any earlier. Every hand substitution at line 690 measured the same two flags.
			expect(settled.publishOpenAtAnswer).toBe(false)
			expect(settled.publishFinishedAtAnswer).toBe(true)
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
		})

		it("refuses a write the cancellation fence cancelled during its re-check", async () => {
			const holder = createCancellableTask()
			const held = guardedWrite(holder.task, "new.txt", "data", "create").catch((error: unknown) => error)
			await waitUntilOpen()

			// The shape the gate's own comment names: the latch is a mutable flag, so this fixture moves
			// the fence and leaves the latch down. The write was submitted with both unchanged.
			const canceller = createCancellableTask()
			flipOnNextCheck(canceller.moveGenerationNow)
			const answer = recordAnswer(guardedWrite(canceller.task, "new.txt", "data", "create"))
			release.open()
			await held
			const settled = await answer.settled

			expect(asGuardRejection((settled as { rejection?: unknown }).rejection).message).toBe(CANCELLED)
			expect(settled.publishOpenAtAnswer).toBe(false)
			expect(settled.publishFinishedAtAnswer).toBe(true)
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
		})

		it("publishes when neither the latch nor the fence moved during the re-check", async () => {
			const writer = createCancellableTask()

			const answer = recordAnswer(guardedWrite(writer.task, "new.txt", "data", "create"))
			release.open()
			const settled = await answer.settled

			// Negative control on the two rows above: the gate must not refuse a write that nothing
			// cancelled, or the two refusals above would prove nothing about the gate.
			expect(settled.outcome).toBe("published")
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
		})

		it("leaves no unhandled rejection when the refusal releases a still-queued chain entry", async () => {
			// The refusal at guardedWrite.ts line 701 rejects the reserved slot's own work promise while
			// this write's chain entry is still queued behind the holder's, so the entry has not reached
			// the await at line 150 yet and the rejected promise has no handler on it. Node's
			// unhandled-rejection check runs on the current turn, long before the queued turn arrives, so
			// the handler has to exist at creation rather than when the entry finally runs.
			const unhandled: string[] = []
			const listener = (reason: unknown): void => {
				if (reason instanceof GuardRejectedError && reason.message === CANCELLED) {
					unhandled.push(reason.message)
				}
			}
			process.on("unhandledRejection", listener)
			try {
				const holder = createCancellableTask()
				const held = guardedWrite(holder.task, "new.txt", "data", "create").catch((error: unknown) => error)
				await waitUntilOpen()

				const canceller = createCancellableTask()
				flipOnNextCheck(canceller.abortNow)
				const answer = recordAnswer(guardedWrite(canceller.task, "new.txt", "data", "create"))

				// Event-loop turns pass here while the holder's publish is still open, which is the window
				// the check runs in: the queued entry cannot reach its await before the timer fires.
				await delay(30)
				expect(unhandled.join(" | ")).toBe("")

				release.open()
				await held
				const settled = await answer.settled
				// The handler must not consume the verdict: this caller still receives the refusal, and the
				// writer still ran exactly once, for the holder's publish.
				expect(asGuardRejection((settled as { rejection?: unknown }).rejection).message).toBe(CANCELLED)
				expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			} finally {
				process.off("unhandledRejection", listener)
			}
		})
	})
})
