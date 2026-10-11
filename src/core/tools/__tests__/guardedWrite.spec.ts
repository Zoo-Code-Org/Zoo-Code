/**
 * Tests for the guarded-write compare-and-swap core (upstream epic #1375,
 * phase A4a).
 *
 * Covers guard selection through the S2 observation registry, version-token
 * CAS, remediation messages, and the per-absolute-path FIFO chain: FIFO
 * ordering, exactly-one winner under concurrency, no wedge after a rejected
 * link, and independence across paths.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { createIfAbsent, guardedWrite, replaceIfVersion, resetChain } from "../guardedWrite"
import { resolvePublishTarget, safeWriteText } from "../../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../../utils/versionToken"
import { acquireFileLock } from "../../../utils/fileLock"
import { ObservationRegistry } from "../../task/observationRegistry"
import type { Task } from "../../task/Task"

// -- Mocks -------------------------------------------------------------------

vi.mock("fs/promises", () => ({
	access: vi.fn(),
	stat: vi.fn(),
}))

vi.mock("../../../utils/versionToken", () => ({
	computeVersionToken: vi.fn(),
}))

vi.mock("../../../utils/fileLock", () => ({
	acquireFileLock: vi.fn(async () => releaseMock), // resolves to the release function
}))

vi.mock("../../../services/file-safety/safeWriteText", () => ({
	safeWriteText: vi.fn(),
	resolvePublishTarget: vi.fn(async (p: string) => p),
}))

const mockedFsAccess = vi.mocked(fs.access)
const mockedComputeVersionToken = vi.mocked(computeVersionToken)
const mockedSafeWriteText = vi.mocked(safeWriteText)
const mockedResolvePublishTarget = vi.mocked(resolvePublishTarget)
let releaseMock: () => Promise<void> = async () => {}
const mockedAcquireFileLock = vi.mocked(acquireFileLock)

// -- Fixtures ----------------------------------------------------------------

const WORKSPACE = "/test/workspace"

/** Resolve a fixture path the same way guardedWrite resolves task.cwd-relative paths. */
const abs = (relPath: string): string => path.resolve(WORKSPACE, relPath)

interface MockTaskOptions {
	cwd?: string
	observationRegistry?: ObservationRegistry
}

/**
 * Minimal structural Task: guardedWrite reads task.cwd, task.observationRegistry and
 * task.abort (the flag Task.dispose() sets). The real Task constructor needs the
 * full provider machinery, so a single documented double cast stands in for the class.
 */
function createMockTask(options: MockTaskOptions = {}): Task {
	const task = {
		cwd: options.cwd ?? WORKSPACE,
		observationRegistry: options.observationRegistry ?? new ObservationRegistry(),
		abort: false,
	}
	return task as unknown as Task
}

// -- Tests -------------------------------------------------------------------

describe("guardedWrite (S4a, epic #1375)", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		resetChain()
	})

	describe("unobserved create", () => {
		it("succeeds when the file is absent and publishes via safeWriteText", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello", {
				preCommitVerify: expect.any(Function),
			})
		})

		it("fails with the read-first remediation when the file exists - nothing published", async () => {
			mockedFsAccess.mockResolvedValue(undefined)
			const task = createMockTask()

			await expect(guardedWrite(task, "existing.txt", "hello", "create")).rejects.toThrow(
				"File already exists at " +
					abs("existing.txt") +
					" and was not read before this write -- read the file first, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})

		it("rethrows I/O errors that are not ENOENT verbatim (no guard verdict on access failure)", async () => {
			const failures = [{ code: "EACCES" }, null, "volume offline", new Error("EIO-ish failure")]
			for (const failure of failures) {
				mockedFsAccess.mockRejectedValueOnce(failure)
				await expect(createIfAbsent(abs("io-error.txt"), "x")).rejects.toBe(failure)
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

			await expect(replaceIfVersion(abs("locked.txt"), "v1", "next")).rejects.toBe(failure)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})
	describe("unobserved update", () => {
		it("succeeds when the file is absent (same create guard)", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello", {
				preCommitVerify: expect.any(Function),
			})
		})

		it("fails with the read-first remediation when the file exists - nothing published", async () => {
			mockedFsAccess.mockResolvedValue(undefined)
			const task = createMockTask()

			await expect(guardedWrite(task, "existing.txt", "hello", "update")).rejects.toThrow(
				"File already exists at " +
					abs("existing.txt") +
					" and was not read before this write -- read the file first, then retry.",
			)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
		})
	})

	describe("observed create", () => {
		it("recreates a file that vanished after the read", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("gone.txt"), "v1")
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "gone.txt", "back", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("gone.txt"), "back", {
				preCommitVerify: expect.any(Function),
			})
		})

		it("goes through the version guard when the file still exists", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("kept.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "kept.txt", "rewritten", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("kept.txt"), "rewritten", {
				preCommitVerify: expect.any(Function),
			})
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content", {
				preCommitVerify: expect.any(Function),
			})
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "patched", {
				preCommitVerify: expect.any(Function),
			})
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

	describe("observation refresh after a publish", () => {
		it("records the published token so a later write needs no re-read", async () => {
			const task = createMockTask()
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v-created")

			await guardedWrite(task, "created.txt", "hello", "create")

			// The created file was never read, so without this the registry stays empty
			// and the next write fails with "File not read yet".
			expect(task.observationRegistry.get(abs("created.txt"))?.version).toBe("v-created")

			mockedFsAccess.mockResolvedValue(undefined)
			mockedComputeVersionToken.mockResolvedValue("v-created")
			await guardedWrite(task, "created.txt", "again", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("created.txt"), "again", {
				preCommitVerify: expect.any(Function),
			})
		})

		it("replaces the read-time token after a successful update", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined)
			// First call: the CAS check. Second call: the token of what was just written.
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValueOnce("v2")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "patched", "edit")

			// Leaving v1 here makes the next edit fail with "Stale version" even though
			// nothing else touched the file.
			expect(reg.get(abs("doc.txt"))?.version).toBe("v2")
		})
	})

	describe("concurrency: per-path FIFO chain", () => {
		it("two concurrent updates on one path - exactly one publishes, the other fails stale", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("shared.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// The first publish changes the on-disk state (new token).
			mockedSafeWriteText.mockImplementation(async () => {
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			const p1 = guardedWrite(task, "shared.txt", "first", "update")
			const p2 = guardedWrite(task, "shared.txt", "second", "update")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			if (r1.status !== "fulfilled" || r2.status !== "rejected") {
				throw new Error("expected exactly one publish, got " + r1.status + " / " + r2.status)
			}
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(r2.reason.message).toBe(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
		})

		it("observed-absent then two concurrent creates - the second fails stale", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("absent.txt"), "v1") // read before, file later vanished
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask({ observationRegistry: reg })

			let publishes = 0
			mockedSafeWriteText.mockImplementation(async () => {
				publishes += 1
				if (publishes === 1) {
					// After the first publish the file exists again under a new token.
					mockedFsAccess.mockResolvedValue(undefined)
					mockedComputeVersionToken.mockResolvedValue("v2")
				}
			})

			const p1 = guardedWrite(task, "absent.txt", "first", "create")
			const p2 = guardedWrite(task, "absent.txt", "second", "create")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			if (r1.status !== "fulfilled" || r2.status !== "rejected") {
				throw new Error("expected exactly one publish, got " + r1.status + " / " + r2.status)
			}
			expect(publishes).toBe(1)
			expect(r2.reason.message).toContain("Stale version")
			expect(r2.reason.message).toContain("re-read the file, then retry.")
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("settle.txt"), "second", {
				preCommitVerify: expect.any(Function),
			})
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
			const order: string[] = []
			mockedSafeWriteText.mockImplementation(async (_path: string, content: string) => {
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("sub/dir.txt"), "content", {
				preCommitVerify: expect.any(Function),
			})
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(canonical, "content", {
				preCommitVerify: expect.any(Function),
			})
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

			// Plain spelling vs the trailing-separator spelling: with one chain key
			// they are strictly ordered (first matches v1, second sees v2).
			const p1 = guardedWrite(task, canonical, "first", "update")
			const p2 = guardedWrite(task, canonical + "/", "second", "update")
			const [r1, r2] = await Promise.allSettled([p1, p2])

			if (r1.status !== "fulfilled" || r2.status !== "rejected") {
				throw new Error("expected exactly one publish, got " + r1.status + " / " + r2.status)
			}
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(r2.reason.message).toBe(
				"Stale version -- the file changed since you read it (expected v1, current v2); re-read the file, then retry.",
			)
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

			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("x.txt"), "b", {
				preCommitVerify: expect.any(Function),
			})
		})
	})

	describe("atomicity of the guard check and publish", () => {
		it("holds the lock across the version check and the publish", async () => {
			const order: string[] = []
			releaseMock = async () => {
				order.push("release")
			}
			mockedAcquireFileLock.mockImplementation(async () => {
				order.push("acquire")
				return releaseMock
			})
			mockedComputeVersionToken.mockImplementation(async () => {
				order.push("check")
				return "v1"
			})
			mockedSafeWriteText.mockImplementation(async () => {
				order.push("publish")
			})

			const published = await replaceIfVersion(abs("x.txt"), "v1", "new")

			// A writer that honors the same lock cannot slip between the check and the publish,
			// and the token handed back is recomputed before the lock is released.
			expect(order).toEqual(["acquire", "check", "publish", "check", "release"])
			expect(published).toBe("v1")
		})

		it("locks the canonical publish target so a safeWriteJson writer serializes with it", async () => {
			// safeWriteJson resolves its publish target before locking, and acquireFileLock runs
			// with realpath:false. If the guarded write locked the caller's spelling instead,
			// the alias and the referent would take two different lock files and a guarded
			// write could race past a safeWriteJson publish of the same file.
			const alias = abs("alias.txt")
			const referent = abs("target.txt")
			mockedResolvePublishTarget.mockResolvedValueOnce(referent)
			mockedComputeVersionToken.mockResolvedValue("v1")

			await replaceIfVersion(alias, "v1", "new")

			expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
			expect(mockedAcquireFileLock).not.toHaveBeenCalledWith(alias)
			// The publish still goes through the path the caller (and safeWriteText's own
			// resolution) owns, so the observation key and symlink semantics are unchanged.
			expect(mockedSafeWriteText).toHaveBeenCalledWith(alias, "new", { preCommitVerify: expect.any(Function) })
		})

		it("releases the lock when the guard rejects as stale", async () => {
			const order: string[] = []
			releaseMock = async () => {
				order.push("release")
			}
			mockedAcquireFileLock.mockImplementation(async () => {
				order.push("acquire")
				return releaseMock
			})
			mockedComputeVersionToken.mockResolvedValue("v2")

			await expect(replaceIfVersion(abs("x.txt"), "v1", "new")).rejects.toThrow(/Stale version/)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(order).toEqual(["acquire", "release"])
		})

		it("re-checks the version token immediately before the commit rename", async () => {
			// The pre-flight check passes, then a writer that ignores the advisory lock
			// rewrites the file while the staged copy is being written and fsynced.
			mockedComputeVersionToken.mockResolvedValueOnce("v1").mockResolvedValueOnce("v2")

			await replaceIfVersion(abs("x.txt"), "v1", "new")

			// The publish is handed a verifier, so the comparison runs after staging and fsync
			// rather than only before them: the race window shrinks to the commit syscall, and
			// a newer version cannot be replaced by an older one without the write being refused.
			const verifier = mockedSafeWriteText.mock.calls[0]?.[2]?.preCommitVerify
			expect(verifier).toBeTypeOf("function")
			if (verifier) {
				await expect(verifier(abs("x.txt"))).rejects.toThrow(/Stale version at commit time/)
			}
		})

		it("re-asserts absence immediately before the commit rename", async () => {
			mockedComputeVersionToken.mockResolvedValue("v1")
			// Guard check: the file is absent, so the create is allowed to proceed.
			mockedFsAccess.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await createIfAbsent(abs("new.txt"), "content")

			const verifier = mockedSafeWriteText.mock.calls[0]?.[2]?.preCommitVerify
			expect(verifier).toBeTypeOf("function")
			if (verifier) {
				// Still absent: the commit may land.
				mockedFsAccess.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
				await expect(verifier(abs("new.txt"))).resolves.toBeUndefined()
				// Created by someone during the staging span: the commit must be refused rather
				// than clobbering whoever created the file.
				mockedFsAccess.mockResolvedValueOnce(undefined)
				await expect(verifier(abs("new.txt"))).rejects.toThrow(/appeared at/)
			}
		})

		it("holds the lock across the absence check and the create publish", async () => {
			const order: string[] = []
			releaseMock = async () => {
				order.push("release")
			}
			mockedAcquireFileLock.mockImplementation(async () => {
				order.push("acquire")
				return releaseMock
			})
			mockedFsAccess.mockImplementation(async () => {
				order.push("check")
				throw { code: "ENOENT" }
			})
			mockedSafeWriteText.mockImplementation(async () => {
				order.push("publish")
			})

			await createIfAbsent(abs("new.txt"), "hello")

			expect(order).toEqual(["acquire", "check", "publish", "release"])
		})
	})

	describe("cancellation while queued (S4b lifecycle)", () => {
		it("does not publish a queued write after the issuing task is disposed", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1")
			// The first link holds the path's chain, so the second write is genuinely queued.
			let releaseFirst: () => void = () => {}
			const firstGate = new Promise<void>(function (resolve) {
				releaseFirst = resolve
			})
			mockedSafeWriteText.mockImplementationOnce(async () => {
				await firstGate
			})
			const task = createMockTask()
			const first = guardedWrite(task, "queued.txt", "first", "create")
			const second = guardedWrite(task, "queued.txt", "second", "create")
			// Let the first link enter the publish (the chain runs on microtasks) before the
			// disposal lands: Task.dispose() sets task.abort while the second write is still
			// queued behind it.
			await new Promise(function (resolve) {
				setImmediate(resolve)
			})
			task.abort = true
			releaseFirst()
			await first
			await expect(second).rejects.toThrow(/was cancelled/)
			// Only the first write published; the cancelled one touched nothing.
			expect(
				mockedSafeWriteText.mock.calls.map(function (call) {
					return call[1]
				}),
			).toEqual(["first"])
		})

		it("refuses an already-cancelled task's write before any I/O", async () => {
			const task = createMockTask()
			task.abort = true
			await expect(guardedWrite(task, "gone.txt", "x", "create")).rejects.toThrow(/was cancelled/)
			expect(mockedSafeWriteText).not.toHaveBeenCalled()
			expect(mockedFsAccess).not.toHaveBeenCalled()
		})
	})
})

describe("commit-time verifier (S4a, epic #1375)", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		resetChain()
		mockedSafeWriteText.mockImplementation((async (
			p: string,
			_c: string,
			options: { preCommitVerify?: (target: string) => Promise<void> },
		) => {
			// Run the verifier the way safeWriteText does: after staging, immediately before the
			// commit rename. Without this the callback would never execute and the assertions below
			// would pass against a verifier that was never called.
			await options.preCommitVerify?.(p)
			return undefined
		}) as never)
	})

	it("propagates a non-ENOENT access error from the create verifier instead of publishing", async () => {
		const ioError = Object.assign(new Error("EACCES"), { code: "EACCES" })
		mockedFsAccess.mockRejectedValueOnce({ code: "ENOENT" })
		mockedFsAccess.mockRejectedValueOnce(ioError)
		const task = createMockTask()

		await expect(guardedWrite(task, "new-file.txt", "hello", "create")).rejects.toBe(ioError)
	})

	it("rejects when the file appears at commit time on the create path", async () => {
		mockedFsAccess.mockRejectedValueOnce({ code: "ENOENT" })
		mockedFsAccess.mockResolvedValue(undefined)
		const task = createMockTask()

		await expect(guardedWrite(task, "new-file.txt", "hello", "create")).rejects.toThrow(/File appeared at/)
	})

	it("converts a commit-time ENOENT on the observed update path into the re-read remediation", async () => {
		const reg = new ObservationRegistry()
		reg.observe(abs("doc.txt"), "v1")
		const task = createMockTask({ observationRegistry: reg })
		mockedFsAccess.mockResolvedValue(undefined)
		// The guard's read-time check runs first, then the commit-time verifier re-computes the
		// token: the first call is the guard, the second is the verifier finding the file gone.
		mockedComputeVersionToken.mockResolvedValueOnce("v1")
		mockedComputeVersionToken.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		await expect(guardedWrite(task, "doc.txt", "new content", "update")).rejects.toThrow(
			/no longer exists; re-read the file, then retry/,
		)
	})
})
