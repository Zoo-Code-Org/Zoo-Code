/**
 * Tests for the guarded-write compare-and-swap core (upstream epic #1375,
 * phase A4a).
 *
 * Covers guard selection through the S2 observation registry, version-token
 * CAS, remediation messages, and the per-absolute-path FIFO chain: FIFO
 * ordering, last-write-wins for same-task writes through the post-publish
 * observation refresh, no wedge after a rejected link, and independence across
 * paths.
 */

import * as fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { createIfAbsent, guardedWrite, replaceIfVersion, resetChain, GuardRejectedError } from "../guardedWrite"
import { safeWriteText, TargetExistsError } from "../../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../../utils/versionToken"
import { withFileLock } from "../../../utils/fileLock"
import { resolveLockKey } from "../../../services/file-safety/safeWriteText"
import { ObservationRegistry } from "../../task/observationRegistry"
import type { Task } from "../../task/Task"

// -- Mocks -------------------------------------------------------------------

vi.mock("fs/promises", () => ({
	access: vi.fn(),
	stat: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
}))

vi.mock("../../../utils/versionToken", () => ({
	computeVersionToken: vi.fn(),
}))

vi.mock("../../../services/file-safety/safeWriteText", async (importOriginal) => {
	// Keep the real error classes: guardedWrite compares the publish failure against
	// TargetExistsError, so the identity has to be the production one.
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
const mockedComputeVersionToken = vi.mocked(computeVersionToken)
const mockedSafeWriteText = vi.mocked(safeWriteText)

// -- Fixtures ----------------------------------------------------------------

const WORKSPACE = "/test/workspace"

/** Resolve a fixture path the same way guardedWrite resolves task.cwd-relative paths. */
const abs = (relPath: string): string => path.resolve(WORKSPACE, relPath)

interface MockTaskOptions {
	cwd?: string
	observationRegistry?: ObservationRegistry
	abort?: boolean
}

/**
 * Minimal structural Task: guardedWrite only reads task.cwd and
 * task.observationRegistry. The real Task constructor needs the full provider
 * machinery, so a single documented double cast stands in for the class.
 */
/**
 * BigIntStats double for the ancestor-identity pin. BigIntStats is class-backed with no
 * public constructor and the guard reads only dev/ino, so this is a last-resort double
 * assertion (test-local, per AGENTS.md).
 */
function dirStat(ino: bigint): BigIntStats {
	return { dev: 1n, ino } as unknown as BigIntStats
}

function createMockTask(options: MockTaskOptions = {}): Task {
	const task = {
		cwd: options.cwd ?? WORKSPACE,
		abort: options.abort ?? false,
		cancellationGeneration: 0,
		observationRegistry: options.observationRegistry ?? new ObservationRegistry(),
	}
	return task as unknown as Task
}

// -- Tests -------------------------------------------------------------------

describe("guardedWrite (S4a, epic #1375)", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mockedWithFileLock.mockImplementation((filePath, operation) => operation(path.resolve(filePath)))
		// The canonical containment check resolves the workspace first and REFUSES the
		// write when the workspace cannot be resolved, so the default resolves every path
		// to itself: the fixture workspace behaves like a real directory. The containment
		// tests below override this to exercise the link cases.
		mockedFsRealpath.mockImplementation(async (p) => String(p))
		// Nothing on the walked path is a symlink by default; the dangling-link test
		// overrides this for the component it plants.
		mockedFsLstat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		// By default no directory on the way to the target exists, so the ancestor
		// identity pin is empty and the publish assertions stay readable. The pinning
		// tests install real stats.
		mockedFsStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		resetChain()
	})

	describe("unobserved create", () => {
		it("succeeds when the file is absent and publishes via safeWriteText", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello", { failIfExist: true, expectedResolvedPath: abs("new-file.txt"), expectedAncestorIdentities: [] })
		})

		it("publishes caller-supplied bytes unchanged", async () => {
			// The extension host hands over bytes already encoded by VS Code's
			// codec; the guard must pass them to the publish primitive as they are.
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "bytes.txt", Buffer.from([0x00, 0x68]), "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("bytes.txt"), Buffer.from([0x00, 0x68]), { failIfExist: true, expectedResolvedPath: abs("bytes.txt"), expectedAncestorIdentities: [] })
		})

		it("records an unobserved create as complete so a later full-file update is allowed", async () => {
			// Nothing was read, so the model supplied the whole file: the post-publish
			// refresh must record completeness, otherwise the next update would be
			// rejected as a partial read.
			const reg = new ObservationRegistry()
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "new-file.txt", "hello", "create")

			expect(reg.get(abs("new-file.txt"))?.complete).toBe(true)
		})

		it("carries a caller-supplied completeness through the publish for a fresh destination", async () => {
			// A move publishes content built from a view of another file. Recording the
			// create as complete would hand the model authority over source lines it never
			// read, so the caller's completeness has to survive the refresh.
			const reg = new ObservationRegistry()
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "new-file.txt", "hello", "create", false)

			expect(reg.get(abs("new-file.txt"))?.complete).toBe(false)
		})

		it("fails with the read-first remediation when the file exists - nothing published", async () => {
			mockedFsAccess.mockResolvedValue(undefined)
			const task = createMockTask()

			await expect(guardedWrite(task, "existing.txt", "hello", "create")).rejects.toThrow(
				"File already exists at " +
					"existing.txt" +
					" and was not read before this write -- read the file first, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses a create when the target appears between the absence check and the commit", async () => {
			// The advisory lock only serializes writers that take it. A writer that never
			// takes it can create the file after fs.access reported it absent, so the
			// commit itself has to refuse: the no-replace link fails EEXIST and the guard
			// turns that into the same read-first verdict the pre-check produces.
			const task = createMockTask()
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedSafeWriteText.mockRejectedValueOnce(new TargetExistsError(abs("race.txt")))

			await expect(guardedWrite(task, "race.txt", "hello", "create")).rejects.toThrow(
				"File already exists at race.txt and was not read before this write -- read the file first, then retry.",
			)

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("race.txt"), "hello", {
				failIfExist: true,
				expectedResolvedPath: abs("race.txt"),
				expectedAncestorIdentities: [],
			})
		})

		it("rethrows I/O errors that are not ENOENT verbatim (no guard verdict on access failure)", async () => {
			const failures = [{ code: "EACCES" }, null, "volume offline", new Error("EIO-ish failure")]
			for (const failure of failures) {
				mockedFsAccess.mockRejectedValueOnce(failure)
				await expect(createIfAbsent(abs("io-error.txt"), "x", "io-error.txt")).rejects.toBe(failure)
			}
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("deleted-after-read target", () => {
		it("normalizes an ENOENT from the version token into the re-read remediation", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("vanished.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })

			// The file was deleted after the read: the token computation fails
			// with a raw ENOENT, which the guard must convert into the standard
			// re-read-then-retry contract.
			mockedComputeVersionToken.mockRejectedValue({ code: "ENOENT" })

			await expect(guardedWrite(task, "vanished.txt", "next", "update")).rejects.toThrow(
				"File was deleted after it was read",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("rethrows non-ENOENT token failures verbatim from replaceIfVersion", async () => {
			const failure = { code: "EACCES" }
			mockedComputeVersionToken.mockRejectedValueOnce(failure)

			await expect(replaceIfVersion(abs("locked.txt"), "v1", "next", "locked.txt")).rejects.toBe(failure)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})
	describe("unobserved update", () => {
		it("succeeds when the file is absent (same create guard)", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello", { failIfExist: true, expectedResolvedPath: abs("new-file.txt"), expectedAncestorIdentities: [] })
		})

		it("fails with the read-first remediation when the file exists - nothing published", async () => {
			mockedFsAccess.mockResolvedValue(undefined)
			const task = createMockTask()

			await expect(guardedWrite(task, "existing.txt", "hello", "update")).rejects.toThrow(
				"File already exists at " +
					"existing.txt" +
					" and was not read before this write -- read the file first, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("workspace containment", () => {
		it("rejects an absolute path outside the workspace before any lock or publish", async () => {
			const task = createMockTask()

			await expect(guardedWrite(task, "/elsewhere/outside.txt", "data", "create")).rejects.toThrow(
				"Path resolves outside the workspace",
			)

			// Nothing is queued, locked, or touched: the decision is made on the path
			// alone, before the FIFO chain or the filesystem is involved.
			expect(mockedWithFileLock).not.toHaveBeenCalled()
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedFsAccess).not.toHaveBeenCalled()
		})

		it("rejects a relative path that escapes the workspace through dot-dot", async () => {
			const task = createMockTask()

			await expect(guardedWrite(task, "../outside.txt", "data", "create")).rejects.toThrow(
				"Path resolves outside the workspace",
			)

			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("rejects a target whose resolved path leaves the workspace", async () => {
			// The lexical check cannot see a link that lands outside. With the workspace
			// resolvable, the canonical comparison is what rejects the write.
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) {
					return "/real/workspace"
				}
				return "/real/outside/secret.txt"
			})
			const task = createMockTask()

			await expect(guardedWrite(task, "planted.txt", "data", "create")).rejects.toThrow(
				"resolves through a link to outside the workspace",
			)

			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})


		it("fails closed when the workspace itself cannot be resolved", async () => {
			// EACCES/ELOOP on the workspace means a symlink inside it would never be resolved, so
			// the containment decision cannot be made at all: the write is refused rather than
			// falling back to the lexical-only check.
			mockedFsRealpath.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))
			const task = createMockTask()

			await expect(guardedWrite(task, "inside.txt", "data", "create")).rejects.toThrow(
				"Workspace could not be resolved",
			)

			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses a target that runs through a dangling symlink ancestor", async () => {
			// A component of the path exists as a symlink whose referent is gone. realpath
			// reports ENOENT for it, which is also what a not-yet-created directory
			// reports; rejoining the lexical names would authorize a write whose publish
			// lands outside the container that was checked.
			const planted = path.join(path.resolve(WORKSPACE), "linkdir")
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) return path.resolve(WORKSPACE)
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			mockedFsLstat.mockImplementation(async (p) => {
				if (String(p) === planted) {
					return { isSymbolicLink: () => true } as never
				}
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			const task = createMockTask()

			await expect(guardedWrite(task, "linkdir/nested/new.txt", "data", "create")).rejects.toThrow(
				"runs through a link",
			)

			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("authorizes a create under an aliased ancestor and pins the publish's own spelling", async () => {
			// The macOS /var -> /private/var shape: the workspace resolves through a link, and
			// the directory the create lands in does not exist yet. Both the containment check
			// and the publish primitive canonicalize through the nearest existing ancestor, so
			// the write must proceed and the pin must be the SAME canonical spelling the
			// publish computes for itself - two spellings of one file would make the pin
			// reject a write that was just authorized.
			const canonicalRoot = "/real/workspace"
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) return canonicalRoot
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask()

			await guardedWrite(task, "linkdir/new.txt", "data", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			const options = mockedSafeWriteText.mock.calls[0][2] as Record<string, unknown>
			// path.join, not a literal: the canonical spelling is joined the same way the
			// guard and the publish both join it.
			expect(options.expectedResolvedPath).toBe(path.join(canonicalRoot, "linkdir", "new.txt"))
			// No TargetMovedError, no refusal: the guard and the publish agree on the
			// canonical spelling of the file they are about to write.
			expect(mockedSafeWriteText.mock.calls[0][0]).toBe(abs("linkdir/new.txt"))
		})

		it("re-checks containment under the lock, after the wait on the FIFO chain", async () => {
			// The path was inside the workspace when it was queued; a link is swapped in while the
			// write waits. The publish must not follow the new link.
			let targetLookups = 0
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) {
					return "/real/workspace"
				}
				targetLookups++
				return targetLookups === 1 ? "/real/workspace/in.txt" : "/real/outside/secret.txt"
			})
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask()

			await expect(guardedWrite(task, "in.txt", "data", "create")).rejects.toThrow(
				"resolves through a link to outside the workspace",
			)

			expect(targetLookups).toBeGreaterThan(1)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
		it("publishes when the resolved path stays inside the workspace", async () => {
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) {
					return "/real/workspace"
				}
				return "/real/workspace/nested/in.txt"
			})
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask()

			await guardedWrite(task, "nested/in.txt", "data", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("nested/in.txt"), "data", {
				failIfExist: true,
				// The canonical target the containment check authorized is pinned onto the
				// publish, so a link swapped in afterwards cannot redirect it.
				expectedResolvedPath: "/real/workspace/nested/in.txt",
				// No ancestor is pinned here: the fixture stat reports "not on disk".
				expectedAncestorIdentities: [],
			})
		})

		it("refuses a write when the workspace is missing from disk, instead of falling back to the lexical check", async () => {
			// ENOENT on the workspace used to fall through to the lexical-only decision - the
			// exact decision a symlink defeats. With no canonical root there is nothing to
			// contain the write in, so the write is refused rather than published on a weaker
			// guarantee.
			mockedFsRealpath.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const task = createMockTask()

			await expect(guardedWrite(task, "inside.txt", "data", "create")).rejects.toThrow(
				"Workspace could not be resolved",
			)

			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("pins the identity of every existing directory between the workspace root and the target", async () => {
			// expectedResolvedPath pins the NAME that gets published. The pin below is what
			// lets the publish notice that the directory the name sits in is no longer the
			// directory that was authorized.
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			mockedFsStat.mockImplementation(async (p) => {
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) return dirStat(100n)
				if (dir === abs("nested")) return dirStat(200n)
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			const task = createMockTask()

			await guardedWrite(task, "nested/in.txt", "data", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("nested/in.txt"), "data", {
				failIfExist: true,
				expectedResolvedPath: abs("nested/in.txt"),
				expectedAncestorIdentities: [
					{ dir: path.resolve(WORKSPACE), dev: 1n, ino: 100n },
					{ dir: abs("nested"), dev: 1n, ino: 200n },
				],
			})
		})

		it("refuses the publish when an authorized parent directory is swapped after the containment check", async () => {
			// The target name and its resolved path are unchanged, so expectedResolvedPath
			// still matches; what changed is the directory the name lives in - it was replaced
			// by another directory (a link to outside the workspace looks exactly like this).
			// The recorded identities are what catch it, and nothing is published.
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			let statCalls = 0
			mockedFsStat.mockImplementation(async (p) => {
				statCalls++
				// First pass (the pre-queue check) sees the authorized directories; the
				// second pass (under the lock, before the publish) sees a replaced parent.
				const replaced = statCalls > 2
				const dir = String(p)
				if (dir === path.resolve(WORKSPACE)) return dirStat(100n)
				if (dir === abs("nested")) return dirStat(replaced ? 999n : 200n)
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			const task = createMockTask()

			await expect(guardedWrite(task, "nested/in.txt", "data", "create")).rejects.toThrow(
				"A directory on the authorized path was replaced after this write was checked",
			)

			expect(statCalls).toBeGreaterThan(2)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses an already-cancelled task before any containment work starts", async () => {
			// The cancellation verdict must be reached before the first await, so a write for
			// a task that is already gone does not touch the filesystem at all.
			const task = createMockTask({ abort: true })
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })

			await expect(guardedWrite(task, "new-file.txt", "data", "create")).rejects.toThrow(
				"Task was cancelled before this write ran -- the queued publish is not performed.",
			)

			expect(mockedFsRealpath).not.toHaveBeenCalled()
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("refuses a write cancelled while the pre-publish containment check is in flight", async () => {
			// The containment check awaits. A cancel that lands inside that await, followed by
			// a resume, must not be invisible: capturing the generation after the await would
			// record the POST-cancel generation, the dequeue comparison would pass, and the
			// cancelled run's content would publish.
			const task = createMockTask()
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let targetLookups = 0
			mockedFsRealpath.mockImplementation(async (p) => {
				const s = String(p)
				if (s === path.resolve(WORKSPACE)) return s
				targetLookups++
				if (targetLookups === 1) {
					task.abort = true
					task.cancellationGeneration++
					task.abort = false
					await gate
				}
				return s
			})

			const write = guardedWrite(task, "in.txt", "data", "create")
			await new Promise((resolve) => setTimeout(resolve, 0))
			release()

			await expect(write).rejects.toThrow(
				"Task was cancelled before this write ran -- the queued publish is not performed.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("observed create", () => {
		it("recreates a file that vanished after the read", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("gone.txt"), "v1")
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "gone.txt", "back", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("gone.txt"), "back", { failIfExist: true, expectedResolvedPath: abs("gone.txt"), expectedAncestorIdentities: [] })
		})

		it("goes through the version guard when the file still exists", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("kept.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "kept.txt", "rewritten", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("kept.txt"), "rewritten", { expectedResolvedPath: abs("kept.txt"), expectedAncestorIdentities: [] })
		})

		it("fails with the stale remediation suffix when the version moved", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("kept.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined)
			mockedComputeVersionToken.mockResolvedValue("v2")
			const task = createMockTask({ observationRegistry: reg })

			await expect(guardedWrite(task, "kept.txt", "rewritten", "create")).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("defers to the version guard when the access check is denied (not ENOENT)", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("locked.txt"), "v1")
			mockedFsAccess.mockRejectedValue({ code: "EACCES" })
			mockedComputeVersionToken.mockResolvedValue("v2")
			const task = createMockTask({ observationRegistry: reg })

			await expect(guardedWrite(task, "locked.txt", "rewritten", "create")).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("observed update (version CAS)", () => {
		it("publishes when the on-disk version matches the observation", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "new content", "update")

			expect(mockedComputeVersionToken).toHaveBeenCalledWith(abs("doc.txt"))
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})

		it("fails with the stale remediation suffix when the version moved - nothing published", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v2")
			const task = createMockTask({ observationRegistry: reg })

			await expect(guardedWrite(task, "doc.txt", "new content", "update")).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("observed update (read completeness, S4b follow-up #46)", () => {
		it("rejects a full-file update when only a partial read observed the file - no I/O, nothing published", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await expect(guardedWrite(task, "doc.txt", "new content", "update")).rejects.toThrow(
				"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
					"a full-file replacement needs the complete content; re-read the whole file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedComputeVersionToken).not.toHaveBeenCalled()
			expect(mockedFsAccess).not.toHaveBeenCalled()
		})

		it("publishes a full-file update when the observation is complete and the version matches", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", true)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "new content", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})

		it("leaves edit-kind publishes unaffected by a partial observation - the model saw the edited region", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "patched", "edit")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "patched", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})

		it("keeps a partial observation partial after an edit so a later full replacement is rejected", async () => {
			// The edit replaced only the region the model saw. Refreshing the
			// observation to complete would let a following full-file write publish
			// content built from the slice alone.
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "patched", "edit")

			expect(reg.get(abs("doc.txt"))?.complete).toBe(false)

			await expect(guardedWrite(task, "doc.txt", "full replacement", "update")).rejects.toThrow(
				"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
					"a full-file replacement needs the complete content; re-read the whole file, then retry.",
			)
		})

		it("rejects a create-kind full-file overwrite of an existing file when only a partial read observed it", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedFsAccess.mockResolvedValue(undefined) // target still on disk
			const task = createMockTask({ observationRegistry: reg })

			// A "create" whose target exists publishes through the same
			// full-file replacement path as "update": a partial observation must
			// not authorize dropping the content the model never read.
			await expect(guardedWrite(task, "doc.txt", "created", "create")).rejects.toThrow(
				"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
					"a full-file replacement needs the complete content; re-read the whole file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedComputeVersionToken).not.toHaveBeenCalled()
		})

		it("allows a create-kind recreate of a vanished file despite a partial observation - a fresh create needs no prior read", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" }) // target absent
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "created", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "created", { failIfExist: true, expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})

		it("publishes a create-kind overwrite of an existing file when the observation is complete", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined) // target still on disk
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "created", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "created", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})
	})

	describe("observation refresh after publish (S4b review round)", () => {
		it("refreshes the observation with the post-publish token so a consecutive edit does not fail stale", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			// The first publish moves the on-disk token: edit 1's pre-write CAS
			// sees v1, the post-publish refresh sees v2, and edit 2's CAS sees v2.
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValueOnce("v2").mockResolvedValue("v2")

			await guardedWrite(task, "doc.txt", "first edit", "edit")
			await guardedWrite(task, "doc.txt", "second edit", "edit")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("doc.txt"), "second edit", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
			// the observation now carries the post-publish token, complete
			expect(reg.get(abs("doc.txt"))?.version).toBe("v2")
			expect(reg.get(abs("doc.txt"))?.complete).toBe(true)
		})

		it("refreshes as a COMPLETE observation so a consecutive full-file update is not rejected partial", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken
				.mockResolvedValueOnce("v1") // update 1 pre-write CAS
				.mockResolvedValueOnce("v2") // update 1 post-publish refresh
				.mockResolvedValue("v2") // update 2 pre-write CAS

			await guardedWrite(task, "doc.txt", "first", "update")
			await guardedWrite(task, "doc.txt", "second", "update")

			// a refresh recorded as partial would have the second update
			// rejected by the completeness gate
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(reg.get(abs("doc.txt"))?.complete).toBe(true)
		})

		it("keeps the previous observation when the post-publish token cannot be computed (deletion race after publish)", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			// The publish succeeded but the file was deleted before the refresh
			// stat: the token computation rejects (ENOENT) and the guard's
			// .catch normalizes it to undefined. The observation must keep the
			// pre-publish version (the next write fails closed through the
			// standard deleted/stale path) rather than a token-less record.
			mockedComputeVersionToken
				.mockResolvedValueOnce("v1") // edit 1 pre-write CAS
				.mockRejectedValueOnce({ code: "ENOENT" }) // edit 1 post-publish refresh - file deleted
				.mockResolvedValue("v1") // edit 2 pre-write CAS

			await guardedWrite(task, "doc.txt", "first edit", "edit")
			await guardedWrite(task, "doc.txt", "second edit", "edit")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(reg.get(abs("doc.txt"))?.version).toBe("v1")
		})
	})

	describe("edit", () => {
		it("fails read-first when the file was never observed - nothing published, no I/O", async () => {
			const task = createMockTask()

			await expect(guardedWrite(task, "any.txt", "patched", "edit")).rejects.toThrow(
				"File not read yet -- read the file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedComputeVersionToken).not.toHaveBeenCalled()
			expect(mockedFsAccess).not.toHaveBeenCalled()
		})

		it("publishes when the version matches the observation", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "patched", "edit")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "patched", { expectedResolvedPath: abs("doc.txt"), expectedAncestorIdentities: [] })
		})

		it("fails with the stale remediation suffix when the version moved", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v3")
			const task = createMockTask({ observationRegistry: reg })

			await expect(guardedWrite(task, "doc.txt", "patched", "edit")).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v3); re-read the file, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("concurrency: per-path FIFO chain", () => {
		it("two concurrent updates on one path - serialized, both publish against the refreshed observation", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("shared.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// The first publish changes the on-disk state (new token), and the
			// guarded write refreshes the observation to it, so the second
			// write CASes against v2 and publishes too: same-task writes are
			// serialized last-write-wins in submission order, while a token that
			// moves outside the task's own publish still fails stale.
			mockedSafeWriteText.mockImplementation(async () => {
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			const p1 = guardedWrite(task, "shared.txt", "first", "update")
			const p2 = guardedWrite(task, "shared.txt", "second", "update")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			expect(r1.status).toBe("fulfilled")
			expect(r2.status).toBe("fulfilled")
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, abs("shared.txt"), "first", { expectedResolvedPath: abs("shared.txt"), expectedAncestorIdentities: [] })
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, abs("shared.txt"), "second", { expectedResolvedPath: abs("shared.txt"), expectedAncestorIdentities: [] })
		})

		it("observed-absent then two concurrent creates - the second publishes against the refreshed observation", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("absent.txt"), "v1") // read before, file later vanished
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask({ observationRegistry: reg })

			let publishes = 0
			mockedSafeWriteText.mockImplementation(async () => {
				publishes += 1
				if (publishes === 1) {
					// After the first publish the file exists again under a new
					// token, and the guarded write refreshes the observation to it.
					mockedFsAccess.mockResolvedValue(undefined)
					mockedComputeVersionToken.mockResolvedValue("v2")
				}
			})

			const p1 = guardedWrite(task, "absent.txt", "first", "create")
			const p2 = guardedWrite(task, "absent.txt", "second", "create")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			// Both same-task creates serialize: the second CASes against the
			// refreshed v2 observation and publishes its content last-write-wins.
			expect(r1.status).toBe("fulfilled")
			expect(r2.status).toBe("fulfilled")
			expect(publishes).toBe(2)
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, abs("absent.txt"), "first", { failIfExist: true, expectedResolvedPath: abs("absent.txt"), expectedAncestorIdentities: [] })
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, abs("absent.txt"), "second", { expectedResolvedPath: abs("absent.txt"), expectedAncestorIdentities: [] })
		})

		it("the chain settles after a rejection - a later matching write still runs", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("settle.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v2") // already stale at v1
			const task = createMockTask({ observationRegistry: reg })

			const p1 = guardedWrite(task, "settle.txt", "first", "update")
			await expect(p1).rejects.toThrow("Stale version")

			// No resetChain: the rejected link must not wedge the chain. The
			// caller re-reads the file (observation refreshed to v2) and retries.
			reg.observe(abs("settle.txt"), "v2")
			const p2 = guardedWrite(task, "settle.txt", "second", "update")
			await expect(p2).resolves.toBeUndefined()

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("settle.txt"), "second", { expectedResolvedPath: abs("settle.txt"), expectedAncestorIdentities: [] })
		})

		it("evicts settled chain entries - a later write still serializes in order", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("evict.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// A first write settles; its chain entry is evicted with it.
			const p1 = guardedWrite(task, "evict.txt", "first", "update")
			await expect(p1).resolves.toBeUndefined()

			// Two rapid writes submitted after the eviction must still run one
			// at a time in submission order (the eviction must not drop the
			// chain for in-flight or just-enqueued links).
			const order: (string | Uint8Array)[] = []
			mockedSafeWriteText.mockImplementation(async (_path: string, content: string | Uint8Array) => {
				order.push(content)
			})
			const p2 = guardedWrite(task, "evict.txt", "second", "update")
			const p3 = guardedWrite(task, "evict.txt", "third", "update")
			await Promise.all([p2, p3])

			expect(order).toEqual(["second", "third"])
			// Three publishes in total: the settled first write plus the two
			// serialized rapid writes.
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(3)
		})

		it("writes on different paths are independent (no cross-path serialization)", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("a.txt"), "v1")
			reg.observe(abs("b.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			const p1 = guardedWrite(task, "a.txt", "a", "update")
			const p2 = guardedWrite(task, "b.txt", "b", "update")
			await Promise.all([p1, p2])

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
		})
	})

	describe("path resolution", () => {
		it("resolves a relative path against task.cwd", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("sub/dir.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "sub/dir.txt", "content", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("sub/dir.txt"), "content", { expectedResolvedPath: abs("sub/dir.txt"), expectedAncestorIdentities: [] })
		})

		it("normalizes an already-absolute input (trailing separator) to the observation key", async () => {
			const reg = new ObservationRegistry()
			const canonical = abs("sub/dir.txt")
			// ReadFileTool observes under path.resolve(task.cwd, relPath) — the
			// canonical spelling. A write addressed with a trailing separator used
			// to bypass the observation (isAbsolute passthrough) and fail
			// "File already exists" / "File not read yet" for a file that was read.
			reg.observe(canonical, "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, canonical + "/", "content", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(canonical, "content", { expectedResolvedPath: canonical, expectedAncestorIdentities: [] })
		})

		it("serializes two spellings of one file through a single chain key", async () => {
			const reg = new ObservationRegistry()
			const canonical = abs("shared2.txt")
			reg.observe(canonical, "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// The first publish changes the on-disk state (new token).
			mockedSafeWriteText.mockImplementation(async () => {
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			// Plain spelling vs the trailing-separator spelling: with one chain
			// key they are strictly ordered. The first matches v1 and publishes;
			// its post-publish refresh records v2, so the second CASes against
			// v2 and publishes too (serialized same-task writes).
			const p1 = guardedWrite(task, canonical, "first", "update")
			const p2 = guardedWrite(task, canonical + "/", "second", "update")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			expect(r1.status).toBe("fulfilled")
			expect(r2.status).toBe("fulfilled")
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, canonical, "first", { expectedResolvedPath: canonical, expectedAncestorIdentities: [] })
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, canonical, "second", { expectedResolvedPath: canonical, expectedAncestorIdentities: [] })
		})
	})

	describe("lock serialization with other writers", () => {
		it("holds the shared advisory lock across the version check and the publish", async () => {
			// The guard decision and the publish must be one operation under the same
			// advisory lock that safeWriteJson and task-history deletion use, otherwise
			// a lock-using writer can land between the check and the write.
			const order: string[] = []
			mockedWithFileLock.mockImplementation(async (filePath, operation) => {
				order.push("lock")
				const result = await operation(path.resolve(filePath))
				order.push("release")
				return result
			})
			mockedComputeVersionToken.mockImplementation(async () => {
				order.push("check")
				return "v1"
			})
			mockedSafeWriteText.mockImplementation(async () => {
				order.push("publish")
			})

			await replaceIfVersion(abs("a.txt"), "v1", "content", "a.txt")

			expect(order).toEqual(["lock", "check", "publish", "check", "release"])
			expect(mockedWithFileLock).toHaveBeenCalledWith(abs("a.txt"), expect.any(Function))
		})

		it("holds the same lock across the absence check and the publish for an unobserved create", async () => {
			const order: string[] = []
			mockedWithFileLock.mockImplementation(async (filePath, operation) => {
				order.push("lock")
				const result = await operation(path.resolve(filePath))
				order.push("release")
				return result
			})
			mockedFsAccess.mockImplementation(async () => {
				order.push("check")
				throw { code: "ENOENT" }
			})
			mockedSafeWriteText.mockImplementation(async () => {
				order.push("publish")
			})

			mockedComputeVersionToken.mockImplementation(async () => {
				order.push("token")
				return "v1"
			})

			await createIfAbsent(abs("new.txt"), "hello", "new.txt")

			expect(order).toEqual(["lock", "check", "publish", "token", "release"])
		})

		it("locks the resolved publish target instead of the link path", async () => {
			// proper-lockfile keys by the path it is given, so a symlink alias and its
			// referent would take two locks for one file. The guard must lock the key
			// every other writer to that file uses.
			const referent = abs("real/file.txt")
			mockedResolveLockKey.mockResolvedValue(referent)
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")

			await createIfAbsent(abs("link.txt"), "hello", "link.txt")

			expect(mockedResolveLockKey).toHaveBeenCalledWith(abs("link.txt"))
			expect(mockedWithFileLock).toHaveBeenCalledWith(referent, expect.any(Function))
		})

		it("reads the post-publish token inside the lock, before releasing it", async () => {
			// A peer lock-using writer can publish in the gap between the publish and
			// a post-publish stat made after the lock is released, and the task would
			// then record that peer's token as its own observation.
			const order: string[] = []
			mockedWithFileLock.mockImplementation(async (filePath, operation) => {
				order.push("lock")
				const result = await operation(path.resolve(filePath))
				order.push("release")
				return result
			})
			mockedComputeVersionToken.mockImplementation(async () => {
				order.push("check")
				return "v1"
			})
			mockedSafeWriteText.mockImplementation(async () => {
				order.push("publish")
				return undefined
			})

			const token = await replaceIfVersion(abs("a.txt"), "v1", "content", "a.txt")

			expect(order).toEqual(["lock", "check", "publish", "check", "release"])
			expect(token).toBe("v1")
		})
	})

	describe("resetChain", () => {
		it("detaches pending links so later writes start a fresh chain", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("x.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "x.txt", "a", "update")
			resetChain()
			await guardedWrite(task, "x.txt", "b", "update")

			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("x.txt"), "b", { expectedResolvedPath: abs("x.txt"), expectedAncestorIdentities: [] })
		})
	})

	it("does not run a queued write once the owning task is cancelled", async () => {
		const task = createMockTask({ abort: true })
		mockedFsAccess.mockRejectedValue({ code: "ENOENT" })

		await expect(guardedWrite(task, "new-file.txt", "hello", "create")).rejects.toThrow(
			"Task was cancelled before this write ran -- the queued publish is not performed.",
		)

		expect(mockedSafeWriteText).not.toHaveBeenCalled()
	})

	it("refuses a queued write whose task was cancelled and resumed before its turn", async () => {
		// A write parks on the path chain behind another write for a different task, so it
		// has not reached its own checks yet. Its task is then cancelled and resumed: by the
		// time the link dequeues, abort is back to false, and the flag alone cannot tell the
		// write that it belongs to the cancelled run. The captured generation can.
		const blocker = createMockTask()
		const cancelled = createMockTask()
		mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
		let releaseCheck!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseCheck = resolve
		})
		let accessCalls = 0
		mockedFsAccess.mockImplementation(async () => {
			accessCalls++
			if (accessCalls === 1) {
				await gate
			}
			throw { code: "ENOENT" }
		})

		const first = guardedWrite(blocker, "queued.txt", "first", "create")
		const second = guardedWrite(cancelled, "queued.txt", "second", "create")

		// Both links have captured their generation; the first is parked inside its
		// absence check with the second still queued behind it on the same path.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(accessCalls).toBe(1)

		cancelled.abort = true
		cancelled.cancellationGeneration++
		cancelled.abort = false

		releaseCheck()
		await first
		await expect(second).rejects.toThrow(
			"Task was cancelled before this write ran -- the queued publish is not performed.",
		)

		// Only the write that was already running published; the cancelled one did not.
		expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
		expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("queued.txt"), "first", { failIfExist: true, expectedResolvedPath: abs("queued.txt"), expectedAncestorIdentities: [] })
	})

	it("re-checks cancellation under the publish lock before writing", async () => {
		// The dequeue check passed; the abort landed while the lock was being taken,
		// so the guard must refuse before the publish rather than write for a task that
		// is already gone.
		const task = createMockTask()
		mockedWithFileLock.mockImplementation(function (filePath, operation) {
			task.abort = true
			return operation(path.resolve(filePath))
		})
		mockedFsAccess.mockRejectedValue({ code: "ENOENT" })

		await expect(guardedWrite(task, "new-file.txt", "hello", "create")).rejects.toThrow(
			"Task was cancelled before this write published -- nothing was written.",
		)

		expect(mockedSafeWriteText).not.toHaveBeenCalled()
	})

	it("re-checks cancellation after the awaited preflight, before publication starts", async () => {
		// The abort lands while the version token is being computed. The guard has to
		// refuse on the way to the publish, not write for a task that is already gone.
		mockedComputeVersionToken.mockImplementation(async () => {
			task.abort = true
			return "v1"
		})
		const reg = new ObservationRegistry()
		reg.observe(abs("a.txt"), "v1", true)
		const task = createMockTask({ observationRegistry: reg })

		await expect(guardedWrite(task, "a.txt", "content", "update")).rejects.toThrow(
			"Task was cancelled before this write published -- nothing was written.",
		)

		expect(mockedSafeWriteText).not.toHaveBeenCalled()
	})

	it("names the caller's path, not the resolved absolute path, in a model-facing rejection", async () => {
		// The guard key stays absolute, but the message and the error field go to the
		// model, so they must not carry a user-specific absolute path.
		mockedFsAccess.mockResolvedValue(undefined)
		const task = createMockTask()

		let error: GuardRejectedError | undefined
		await guardedWrite(task, "src/thing.ts", "hello", "create").catch((e: unknown) => {
			if (e instanceof GuardRejectedError) {
				error = e
				return
			}
			throw e
		})

		expect(error?.message).toBe(
			"File already exists at src/thing.ts and was not read before this write -- read the file first, then retry.",
		)
		expect(error?.path).toBe("src/thing.ts")
		expect(mockedSafeWriteText).not.toHaveBeenCalled()
	})
	it("names the caller's path on a stale-version rejection as well", async () => {
		// The stale branch is the most common rejection, so it has to follow the same rule
		// as the create, delete and cancellation branches.
		mockedFsAccess.mockResolvedValue(undefined)
		mockedComputeVersionToken.mockResolvedValue("v2")
		const reg = new ObservationRegistry()
		reg.observe(abs("src/thing.ts"), "v1", true)
		const task = createMockTask({ observationRegistry: reg })

		let staleError: GuardRejectedError | undefined
		await guardedWrite(task, "src/thing.ts", "hello", "update").catch((e: unknown) => {
			if (e instanceof GuardRejectedError) {
				staleError = e
				return
			}
			throw e
		})

		expect(staleError?.message).toBe(
			"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
		)
		expect(staleError?.path).toBe("src/thing.ts")
		expect(mockedSafeWriteText).not.toHaveBeenCalled()
	})
})
