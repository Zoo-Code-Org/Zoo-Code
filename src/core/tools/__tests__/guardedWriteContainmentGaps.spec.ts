/**
 * Containment-line mutation gaps for the guarded-write core (upstream epic #1375).
 *
 * Every row here aims at a mutant that scripts/stryker-diff.mjs reported as Survived or
 * NoCoverage on the changed lines of src/core/tools/guardedWrite.ts: the lexical containment
 * predicate, the ancestor chain a write pins, the taxonomy of stat, realpath and lstat
 * failures inside that pin, and the walk up to the nearest existing ancestor. The assertions
 * name the verdict the guard must report, the identity it must pin, the record it must hand
 * the writer, and the request it must make of the filesystem.
 */

import * as fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { guardedWrite, resetChain, GuardRejectedError } from "../guardedWrite"
import { safeWriteText, type DirectoryIdentity } from "../../../services/file-safety/safeWriteText"
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
 * BigIntStats double for one directory's identity. BigIntStats is a class backed with no public
 * constructor and the guard reads only dev, ino and the request options, so this is a
 * last-resort double assertion (test-local, per AGENTS.md).
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

/** True when a recorded stat or lstat call asked for bigint identities. */
function requestedBigInt(call: readonly unknown[]): boolean {
	return hasBigIntFlag(call[1])
}

/** Narrow an unknown thrown value to the guard verdict, failing loudly otherwise. */
function asGuardRejection(thrown: unknown): GuardRejectedError {
	if (thrown instanceof GuardRejectedError) {
		return thrown
	}
	throw new Error("expected a guard rejection, got " + String(thrown))
}

/** The record the publish was handed, read off the mocked writer call. */
function publishOptions(callIndex: number): {
	expectedResolvedPath?: string
	expectedAncestorIdentities?: readonly DirectoryIdentity[]
} {
	const call = mockedSafeWriteText.mock.calls[callIndex]
	if (call === undefined) {
		throw new Error("expected the publish to reach the writer, it did not")
	}
	return call[2] ?? {}
}

/** The pinned ancestor for one directory, failing loudly when the pin omits it. */
function ancestorFor(ancestors: readonly DirectoryIdentity[] | undefined, dir: string): DirectoryIdentity {
	const normalized = path.resolve(dir)
	const found = (ancestors ?? []).find((entry) => entry.dir === normalized)
	if (found === undefined) {
		throw new Error(
			"no pinned ancestor for " + normalized + ", pinned: " + (ancestors ?? []).map((e) => e.dir).join(", "),
		)
	}
	return found
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

/** One directory on the authorized path: its identity and the answers it gives, request by request. */
interface DirFixture {
	dev: bigint
	ino: bigint
	/** Identity reported on each successive request; the last entry repeats once they run out. */
	reported: { dev: bigint; ino: bigint }[]
	requests: number
}

const OUTSIDE = "Path resolves outside the workspace -- write inside the workspace, then retry."
const UNRESOLVED =
	"Path could not be resolved, so it cannot be checked against the workspace -- retry with a path inside the workspace."
const REPLACED = "A directory on the authorized path was replaced after this write was checked -- nothing was written."
const WORKSPACE_UNRESOLVED =
	"Workspace could not be resolved, so this write cannot be checked against it -- retry with a path inside the workspace."

describe("guardedWrite containment mutation gaps (epic #1375)", () => {
	/** Directories that exist on the fixture disk, keyed by their resolved path. */
	let dirs: Map<string, DirFixture>
	/** Directories whose stat or realpath or lstat must fail with a given code. */
	let statFailures: Map<string, string>
	let realpathFailures: Map<string, string>
	let linkTargets: Map<string, boolean>

	/** Put a directory on the fixture disk. Extra entries answer later requests, e.g. a swap. */
	function putDir(relOrAbsPath: string, dev: bigint, ino: bigint, reported?: { dev: bigint; ino: bigint }[]): void {
		const key = path.isAbsolute(relOrAbsPath) ? path.resolve(relOrAbsPath) : abs(relOrAbsPath)
		dirs.set(key, { dev, ino, reported: reported ?? [{ dev, ino }], requests: 0 })
	}

	beforeEach(() => {
		vi.resetAllMocks()
		dirs = new Map()
		statFailures = new Map()
		realpathFailures = new Map()
		linkTargets = new Map()
		mockedWithFileLock.mockImplementation((filePath, operation) => operation(path.resolve(filePath)))
		mockedResolveLockKey.mockImplementation(async (p: string) => p)
		mockedFsAccess.mockRejectedValue(errno("ENOENT"))
		mockedFsMkdir.mockResolvedValue(undefined)
		mockedComputeVersionToken.mockResolvedValue("v1")
		mockedSafeWriteText.mockResolvedValue(undefined)
		mockedFsRealpath.mockImplementation(async (p: unknown) => {
			const key = String(p)
			const code = realpathFailures.get(key)
			if (code !== undefined) {
				throw errno(code)
			}
			return key
		})
		mockedFsLstat.mockImplementation(async (p: unknown, options?: unknown) => {
			const key = String(p)
			const isLink = linkTargets.get(key)
			if (isLink === undefined) {
				throw errno("ENOENT")
			}
			return {
				...statsDouble(1n, 1n, hasBigIntFlag(options)),
				isSymbolicLink: () => isLink,
			} as unknown as BigIntStats
		})
		mockedFsStat.mockImplementation(async (p: unknown, options?: unknown) => {
			const key = String(p)
			const code = statFailures.get(key)
			if (code !== undefined) {
				throw errno(code)
			}
			const fixture = dirs.get(key)
			if (fixture === undefined) {
				throw errno("ENOENT")
			}
			const answer = fixture.reported[Math.min(fixture.requests, fixture.reported.length - 1)]
			if (answer === undefined) {
				throw errno("ENOENT")
			}
			fixture.requests += 1
			// The double answers the request the guard actually made: a request without the bigint
			// flag gets number identities, exactly as fs/promises returns Stats instead of
			// BigIntStats, so a dropped flag shows up as an identity that cannot match the recheck.
			return statsDouble(answer.dev, answer.ino, hasBigIntFlag(options))
		})
		resetChain()
	})

	describe("the lexical containment line, decided before anything is queued or touched", () => {
		it("refuses a target that is the workspace root itself", async () => {
			const task = createMockTask()

			const thrown = await guardedWrite(task, ".", "data", "create").catch((error: unknown) => error)

			// path.relative reports the empty string here, and the empty string is the only disjunct
			// that excludes this target: the ".." spellings do not match it and an empty relative
			// path is not absolute. Dropping that disjunct, or comparing against any other literal,
			// lets the write through.
			expect(asGuardRejection(thrown).message).toBe(OUTSIDE)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedFsRealpath).not.toHaveBeenCalled()
			expect(mockedFsStat).not.toHaveBeenCalled()
		})

		it("refuses a target spelled as the parent of the workspace", async () => {
			const task = createMockTask()

			const thrown = await guardedWrite(task, "..", "data", "create").catch((error: unknown) => error)

			// path.relative reports exactly the two-dot spelling for this one, so it reaches only the
			// second disjunct: it does not start with the two-dot separator prefix and it is not
			// absolute.
			expect(asGuardRejection(thrown).message).toBe(OUTSIDE)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses a target spelled through the parent, which the prefix disjunct excludes", async () => {
			const task = createMockTask()

			const thrown = await guardedWrite(task, path.join("..", "sibling.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			expect(asGuardRejection(thrown).message).toBe(OUTSIDE)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("the ancestor chain a write pins, and the identity it pins", () => {
		it("pins every directory between the workspace root and the target's parent", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			const ancestors = publishOptions(0).expectedAncestorIdentities ?? []
			expect(ancestors.map((entry) => entry.dir)).toEqual([abs("."), abs("sub"), abs(path.join("sub", "deep"))])
		})

		it("hands the writer exactly one root entry when the target sits in the workspace itself", async () => {
			putDir(".", 7n, 7001n)
			const task = createMockTask()

			await guardedWrite(task, "new.txt", "data", "create")

			// path.relative reports the empty string for the directory that holds this target, because
			// that directory IS the workspace. Splitting the empty string yields one empty segment and
			// joining it back yields the root again, so a chain built from the empty spelling pins the
			// same directory twice from the same reading, which proves nothing about a directory that
			// moved.
			const ancestors = publishOptions(0).expectedAncestorIdentities ?? []
			expect(ancestors.map((entry) => entry.dir)).toEqual([abs(".")])
		})

		it("pins each identity from a bigint request, so a wide inode still matches the recheck", async () => {
			// 2^53+1: the smallest positive integer a double cannot hold exactly, which is the size
			// an NTFS file index or an ext4 inode can really reach.
			const WIDE_INO = 9007199254740993n
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, WIDE_INO)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			// A request that drops the bigint flag makes fs/promises answer with Stats, whose dev and
			// ino are numbers, and the recheck under the lock asks with bigint: number 7002 and
			// bigint 7002 are not the same value under !==, so the pin this write authorized stops
			// matching the directory it was taken from.
			expect(publishOptions(0).expectedAncestorIdentities?.map((entry) => entry.ino)).toEqual([
				7001n,
				WIDE_INO,
				7003n,
			])
			expect(mockedFsStat.mock.calls.every((call) => requestedBigInt(call))).toBe(true)
		})

		it("refuses the publish when a directory on the pinned chain was replaced before the commit", async () => {
			putDir(".", 7n, 7001n)
			// Third request is the recheck under the lock: pin pass one, pin pass two, then the recheck.
			putDir("sub", 7n, 7002n, [
				{ dev: 7n, ino: 7002n },
				{ dev: 7n, ino: 7002n },
				{ dev: 7n, ino: 8111n },
			])
			putDir(path.join("sub", "deep"), 7n, 7003n)
			const task = createMockTask()

			const thrown = await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			expect(asGuardRejection(thrown).message).toBe(REPLACED)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("the taxonomy of stat failures while pinning the chain", () => {
		it("skips a component the stat reports as missing, and pins the rest", async () => {
			putDir(".", 7n, 7001n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			// "sub" does not exist yet: the publish will make it, so it has no identity to pin.
			expect(publishOptions(0).expectedAncestorIdentities?.map((entry) => entry.dir)).toEqual([
				abs("."),
				abs(path.join("sub", "deep")),
			])
		})

		it("skips a component the stat reports as not a directory, and pins the rest", async () => {
			putDir(".", 7n, 7001n)
			statFailures.set(abs("sub"), "ENOTDIR")
			putDir(path.join("sub", "deep"), 7n, 7003n)
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			// ENOTDIR is the other spelling of "this component is not there as a directory": a path
			// component exists as a plain file. Treating it as an unknown identity refuses a write the
			// publish can perform.
			expect(publishOptions(0).expectedAncestorIdentities?.map((entry) => entry.dir)).toEqual([
				abs("."),
				abs(path.join("sub", "deep")),
			])
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
		})

		it("rethrows a stat failure that is neither missing nor not-a-directory", async () => {
			statFailures.set(abs("sub"), "EACCES")
			const task = createMockTask()

			const thrown = await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			// An unreadable parent means the identity is unknown, and pinning nothing for it would let
			// a replacement filed at the same name pass verification and receive the write.
			expect(thrown).not.toBeInstanceOf(GuardRejectedError)
			if (!(thrown instanceof Error && "code" in thrown)) {
				throw new Error("expected the EACCES failure to travel to the caller, got " + String(thrown))
			}
			expect(thrown.code).toBe("EACCES")
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("the taxonomy of realpath failures while pinning the chain", () => {
		it("records no resolved path for a component whose realpath reports it missing", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			realpathFailures.set(abs("sub"), "ENOENT")
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			const ancestors = publishOptions(0).expectedAncestorIdentities ?? []
			const subEntry = ancestorFor(ancestors, abs("sub"))
			// The stat succeeded and the realpath then reported the directory missing: the identity is
			// still known, the location is not, so the record carries the identity and no claim about
			// where the name resolves.
			expect(subEntry.dev).toBe(7n)
			expect(subEntry.ino).toBe(7002n)
			expect("resolvedPath" in subEntry).toBe(false)
			expect("resolvedPath" in ancestorFor(ancestors, abs("."))).toBe(true)
			expect(ancestors.map((entry) => entry.dir)).toEqual([abs("."), abs("sub"), abs(path.join("sub", "deep"))])
		})

		it("records no resolved path for a component whose realpath reports it is not a directory", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			realpathFailures.set(abs("sub"), "ENOTDIR")
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			// The stat answered for this component before the realpath refused it, so the identity is
			// pinned and only the location claim is dropped.
			const ancestors = publishOptions(0).expectedAncestorIdentities ?? []
			const subEntry = ancestorFor(ancestors, abs("sub"))
			expect(subEntry.ino).toBe(7002n)
			expect("resolvedPath" in subEntry).toBe(false)
			expect(ancestors.map((entry) => entry.dir)).toEqual([abs("."), abs("sub"), abs(path.join("sub", "deep"))])
		})

		it("rethrows a realpath failure that is neither missing nor not-a-directory", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			realpathFailures.set(abs("sub"), "EACCES")
			const task = createMockTask()

			const thrown = await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			// An unreadable component leaves the location unknown. Swallowing it and pinning the lexical
			// spelling is what a re-pointed alias defeats.
			expect(thrown).not.toBeInstanceOf(GuardRejectedError)
			if (!(thrown instanceof Error && "code" in thrown)) {
				throw new Error("expected the EACCES failure to travel to the caller, got " + String(thrown))
			}
			expect(thrown.code).toBe("EACCES")
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("the walk up to the nearest existing ancestor", () => {
		it("refuses when the target cannot be resolved for a reason other than missing", async () => {
			realpathFailures.set(abs("new.txt"), "EACCES")
			const task = createMockTask()

			const thrown = await guardedWrite(task, "new.txt", "data", "create").catch((error: unknown) => error)

			expect(asGuardRejection(thrown).message).toBe(UNRESOLVED)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses when an ancestor cannot be resolved for a reason other than missing", async () => {
			// The target is missing, which is the benign spelling, and the walk moves to its parent.
			// The parent is the component that cannot be resolved, and not because it is missing.
			realpathFailures.set(abs(path.join("sub", "new.txt")), "ENOENT")
			realpathFailures.set(abs("sub"), "EACCES")
			const task = createMockTask()

			const thrown = await guardedWrite(task, path.join("sub", "new.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			// The workspace itself resolved, so the walk ran; continuing would join the missing tail
			// onto a location nobody checked.
			expect(asGuardRejection(thrown).message).toBe(UNRESOLVED)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("joins the missing tail onto the nearest ancestor that does resolve", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			putDir(path.join("sub", "deep"), 7n, 7003n)
			// The target and its parent directory do not exist yet; the grandparent does.
			realpathFailures.set(abs(path.join("sub", "deep", "new.txt")), "ENOENT")
			realpathFailures.set(abs(path.join("sub", "deep")), "ENOENT")
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "new.txt"), "data", "create")

			// The walk stops at the first ancestor that resolves and re-joins the missing tail onto it,
			// so the published name is the lexical target the caller named.
			expect(publishOptions(0).expectedResolvedPath).toBe(abs(path.join("sub", "deep", "new.txt")))
			expect(mockedFsLstat).toHaveBeenCalledWith(abs(path.join("sub", "deep")), { bigint: true })
		})

		// The walk has to end. The filesystem root is its own parent, and this fixture puts the
		// workspace AT the filesystem root and lets nothing but the root resolve, so the climb reaches
		// that point and hands back the lexical path it started from. If the end test is mutated away
		// the climb never returns and the test dies on the per-test timeout instead of on an assertion.
		it("stops the climb at the filesystem root and reports the workspace as unresolvable", async () => {
			const task = createMockTask()
			let asked = 0
			mockedFsRealpath.mockImplementation(async (p) => {
				// Only the first request resolves, which is the containment check's look at the
				// workspace. Everything after it is missing, including every step of the climb.
				asked += 1
				if (asked === 1) {
					return String(p)
				}
				throw errno("ENOENT")
			})

			const thrown = await guardedWrite(task, path.join("sub", "new.txt"), "data", "create").catch(
				(error: unknown) => error,
			)

			// The climb has nowhere left to go: dirname of the filesystem root is the root itself, so
			// the walk ends there and hands back the lexical path. The write is then refused because the
			// workspace no longer resolves, and the run ends. If the end-of-chain test is mutated away
			// the climb never ends, so this test dies on the per-test timeout instead of on a verdict.
			expect(asGuardRejection(thrown).message).toBe(WORKSPACE_UNRESOLVED)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("classifies a missing component from a bigint lstat request", async () => {
			putDir(".", 7n, 7001n)
			putDir("sub", 7n, 7002n)
			linkTargets.set(abs(path.join("sub", "deep")), false)
			realpathFailures.set(abs(path.join("sub", "deep", "file.txt")), "ENOENT")
			realpathFailures.set(abs(path.join("sub", "deep")), "ENOENT")
			const task = createMockTask()

			await guardedWrite(task, path.join("sub", "deep", "file.txt"), "data", "create")

			// Missing has two meanings and only one is benign: a not-yet-created directory, or an
			// existing component that is a link whose referent is gone. Telling them apart is a lstat
			// of the component, and the guard asks for it with the same bigint pinning it asks for
			// identities with, so the record it classifies from carries inode values of one type.
			expect(mockedFsLstat).toHaveBeenCalledWith(abs(path.join("sub", "deep")), { bigint: true })
			expect(publishOptions(0).expectedResolvedPath).toBe(abs(path.join("sub", "deep", "file.txt")))
		})
	})
})
