/**
 * Tests for the guarded-write compare-and-swap core (upstream epic #1375,
 * phase A4a).
 *
 * Covers guard selection through the S2 observation registry, version-token
 * CAS, remediation messages, and the per-absolute-path FIFO chain: FIFO
 * ordering, exactly-one winner under concurrency, no wedge after a rejected
 * link, and independence across paths. It also covers the publication-time
 * re-verification that closes the check-to-rename window for writers
 * serialized by the chain.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { describe, expect, it, beforeEach, vi } from "vitest"

import { createIfAbsent, guardedWrite, replaceIfVersion, resetChain } from "../guardedWrite"
import { safeWriteText, type SafeWriteTextOptions } from "../../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../../utils/versionToken"
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

vi.mock("../../../services/file-safety/safeWriteText", () => ({
	safeWriteText: vi.fn(),
}))

const mockedFsAccess = vi.mocked(fs.access)
const mockedComputeVersionToken = vi.mocked(computeVersionToken)
const mockedSafeWriteText = vi.mocked(safeWriteText)

// -- Fixtures ----------------------------------------------------------------

const WORKSPACE = "/test/workspace"

/** Resolve a fixture path the same way guardedWrite resolves task.cwd-relative paths. */
const abs = (relPath: string): string => path.resolve(WORKSPACE, relPath)

interface MockTaskOptions {
	cwd?: string
	observationRegistry?: ObservationRegistry
}

/**
 * Minimal structural Task: guardedWrite only reads task.cwd and
 * task.observationRegistry. The real Task constructor needs the full provider
 * machinery, so a single documented double cast stands in for the class.
 */
function createMockTask(options: MockTaskOptions = {}): Task {
	const task = {
		cwd: options.cwd ?? WORKSPACE,
		observationRegistry: options.observationRegistry ?? new ObservationRegistry(),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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

	describe("publication-time re-verification (check-to-rename window)", () => {
		/**
		 * Drive a simulated race: the mocked publish primitive behaves like
		 * safeWriteText and invokes the pre-commit verification immediately
		 * before the commit rename. The "external writer" acts in that window
		 * (after the guard's entry check, before the pre-commit re-verification)
		 * by changing the mocked on-disk state. Returns a published() probe.
		 */
		const mockPublishWithRace = (mutate: () => void): (() => boolean) => {
			let published = false
			mockedSafeWriteText.mockImplementation(
				async (_path: string, _content: string, options?: SafeWriteTextOptions) => {
					mutate()
					await options?.verifyBeforeCommit?.()
					published = true
				},
			)
			return () => published
		}

		it("createIfAbsent rejects when an external writer creates the file between verification and publication", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" }) // absent at entry
			const task = createMockTask()
			const published = mockPublishWithRace(() => {
				// -- the race: an external writer publishes first ------------------
				mockedFsAccess.mockResolvedValue(undefined) // the file now exists
			})

			await expect(guardedWrite(task, "raced.txt", "mine", "create")).rejects.toThrow(
				"File already exists at " +
					abs("raced.txt") +
					" and was not read before this write -- read the file first, then retry.",
			)
			// nothing was published: the competing writer's file is preserved
			expect(published()).toBe(false)
			// entry check + pre-commit re-check
			expect(mockedFsAccess).toHaveBeenCalledTimes(2)
		})

		it("replaceIfVersion rejects when an external writer modifies the file between verification and publication", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("raced.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1") // matches at entry
			const task = createMockTask({ observationRegistry: reg })
			const published = mockPublishWithRace(() => {
				// -- the race: an external writer rewrites the file ----------------
				mockedComputeVersionToken.mockResolvedValue("v-external")
			})

			await expect(guardedWrite(task, "raced.txt", "mine", "update")).rejects.toThrow(
				"Stale version -- the file changed since you read it (expected v1, current v-external); re-read the file, then retry.",
			)
			expect(published()).toBe(false)
		})

		it("replaceIfVersion rejects deleted-after-read when the file is deleted between verification and publication", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("raced.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })
			const published = mockPublishWithRace(() => {
				// -- the race: an external writer deletes the file -----------------
				mockedComputeVersionToken.mockRejectedValue({ code: "ENOENT" })
			})

			await expect(guardedWrite(task, "raced.txt", "mine", "update")).rejects.toThrow(
				"File was deleted after it was read",
			)
			expect(published()).toBe(false)
		})

		it("rethrows non-guard I/O failures from the pre-commit verification verbatim", async () => {
			const failure = { code: "EACCES" }
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" }) // absent at entry
			const task = createMockTask()
			const published = mockPublishWithRace(() => {
				// the pre-commit re-check hits a real I/O failure, not a guard verdict
				mockedFsAccess.mockRejectedValue(failure)
			})

			await expect(guardedWrite(task, "io-race.txt", "x", "create")).rejects.toBe(failure)
			expect(published()).toBe(false)
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
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
				verifyBeforeCommit: expect.any(Function),
			})
		})
	})
})
