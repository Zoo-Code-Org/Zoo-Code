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

		it("defaults kind to update when the caller omits the argument", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			const task = createMockTask()

			// Every other call in this file passes kind explicitly, so the default was never exercised.
			// The default only matters on the UNOBSERVED path: once a file is observed the guard is
			// chosen by the observation, not by kind. Omitting it must take the create-if-absent guard
			// (which publishes); a default of "edit" would hit the read-first guard and reject instead.
			await guardedWrite(task, "new-file.txt", "hello")

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

		it("uses the update guard when the caller omits the argument on an observed file", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// Documents the contract for the omitted argument on the observed path. Note that this case
			// is NOT load-bearing: once a file is observed the guard is chosen by the observation, so
			// changing the default does not change this call. The load-bearing pin for the default is
			// 'defaults kind to update when the caller omits the argument' on the unobserved path.
			await guardedWrite(task, "doc.txt", "new content")

			expect(mockedComputeVersionToken).toHaveBeenCalledWith(abs("doc.txt"))
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content", {
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

		it("does not probe existence or recreate when an updated file vanished after the read", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			// The file vanished: the CAS token recomputation rejects with ENOENT,
			// which the version guard reports as the deleted-file remediation.
			mockedComputeVersionToken.mockRejectedValue({ code: "ENOENT" })
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })

			await expect(guardedWrite(task, "doc.txt", "new content", "update")).rejects.toThrow(
				"File was deleted after it was read -- the version recorded at read time (v1) no longer exists; re-read the file, then retry.",
			)

			// The existence probe is a "create"-only step: an "update" must not run
			// it (the branch condition short-circuits on kind) and must not recreate
			// the vanished file - only the CAS branch may decide the write.
			expect(mockedFsAccess).not.toHaveBeenCalled()
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

	describe("observation refresh after publication", () => {
		it("re-observes the published token so a second update without a re-read succeeds", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValue("v1")
			// The publish changes the on-disk state: the token moves to v2.
			mockedSafeWriteText.mockImplementation(async () => {
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			await guardedWrite(task, "doc.txt", "one", "update")

			// The registry records what this write published, not the pre-write read.
			expect(reg.get(abs("doc.txt"))?.version).toBe("v2")

			// A second write from the same task without a re-read succeeds: its CAS
			// compares against the content the task itself published.
			await guardedWrite(task, "doc.txt", "two", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
			expect(reg.get(abs("doc.txt"))?.version).toBe("v2")
		})

		it("records an observation after creating an unobserved file so a follow-up write is not treated as unobserved", async () => {
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("created-v1")
			const task = createMockTask()
			// After the create the file exists on disk.
			mockedSafeWriteText.mockImplementation(async () => {
				mockedFsAccess.mockResolvedValue(undefined)
			})

			await guardedWrite(task, "made.txt", "content", "create")

			expect(task.observationRegistry.get(abs("made.txt"))?.version).toBe("created-v1")

			// Without the write-back this second write would take the unobserved
			// branch and fail "File already exists ... was not read before this
			// write" for a file the same task had just created.
			await guardedWrite(task, "made.txt", "revised", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(2)
		})

		it("re-observes after a successful edit write", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken.mockResolvedValue("v1")
			mockedSafeWriteText.mockImplementation(async () => {
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			await guardedWrite(task, "doc.txt", "patched", "edit")

			expect(reg.get(abs("doc.txt"))?.version).toBe("v2")
		})

		it("keeps a published write successful when the post-publication token computation fails", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			const task = createMockTask({ observationRegistry: reg })
			mockedComputeVersionToken
				.mockResolvedValueOnce("v1") // the CAS check at entry passes
				.mockRejectedValueOnce({ code: "EACCES" }) // the post-publication token fails

			await expect(guardedWrite(task, "doc.txt", "new content", "update")).resolves.toBeUndefined()

			// The write published; the failed bookkeeping leaves the previous
			// observation in place (a follow-up write then fails stale and re-reads).
			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(reg.get(abs("doc.txt"))?.version).toBe("v1")
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

		it("holds the submission-time token when the registry moves on while the write waits", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("queued-token.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			let releaseFirst: () => void = () => {}
			const gate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			let publishes = 0
			mockedSafeWriteText.mockImplementation(async (_path: string, content: string) => {
				publishes += 1
				if (content === "first") {
					await gate
				}
				// Each publish moves the on-disk token forward.
				mockedComputeVersionToken.mockResolvedValue("v2")
			})

			const first = guardedWrite(task, "queued-token.txt", "first", "update")
			const second = guardedWrite(task, "queued-token.txt", "second", "update")
			await new Promise((resolve) => setImmediate(resolve))
			// A re-read lands while both writes are still in flight: the registry
			// moves to v2 behind the queued writes.
			reg.observe(abs("queued-token.txt"), "v2")
			releaseFirst()

			await first
			// The second write was submitted against v1. The first write published
			// over that state, so the queued write fails stale instead of publishing
			// content derived from the v1 read over the v2 file. An execution-time
			// registry lookup would rescue it with the refreshed token and lose the
			// first write's update.
			await expect(second).rejects.toThrow("Stale version")
			expect(publishes).toBe(1)
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

		it("a write submitted after an earlier one settled still serializes in submission order", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("evict.txt"), "v1")
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			// A first write settles before the next two are submitted.
			const p1 = guardedWrite(task, "evict.txt", "first", "update")
			await expect(p1).resolves.toBeUndefined()

			// Two rapid writes submitted after that settlement must still run one at a
			// time in submission order. Whether the settled entry has been evicted from the
			// path map is not observable from here, so the test does not claim it.
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

describe("task cancellation (S4a, epic #1375)", () => {
	// The file's shared beforeEach lives inside the main describe, so this top-level one needs its
	// own resets - otherwise assertions here see the previous test's recorded calls.
	beforeEach(() => {
		mockedSafeWriteText.mockClear()
		mockedFsAccess.mockClear()
		mockedComputeVersionToken.mockClear()
		mockedFsAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
	})

	it("drops a queued write when the task is aborted while it waits behind another write", async () => {
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
