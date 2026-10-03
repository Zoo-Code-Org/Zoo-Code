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
import { safeWriteText } from "../../../services/file-safety/safeWriteText"
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
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello")
		})

		it("publishes caller-supplied bytes unchanged", async () => {
			// The extension host hands over bytes already encoded by VS Code's
			// codec; the guard must pass them to the publish primitive as they are.
			mockedFsAccess.mockRejectedValue({ code: "ENOENT" })
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "bytes.txt", Buffer.from([0x00, 0x68]), "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("bytes.txt"), Buffer.from([0x00, 0x68]))
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
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask()

			await guardedWrite(task, "new-file.txt", "hello", "update")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("new-file.txt"), "hello")
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
			mockedComputeVersionToken.mockResolvedValue("v1") // post-publish refresh
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "gone.txt", "back", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledTimes(1)
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("gone.txt"), "back")
		})

		it("goes through the version guard when the file still exists", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("kept.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "kept.txt", "rewritten", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("kept.txt"), "rewritten")
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content")
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "new content")
		})

		it("leaves edit-kind publishes unaffected by a partial observation - the model saw the edited region", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1", false)
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "patched", "edit")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "patched")
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "created")
		})

		it("publishes a create-kind overwrite of an existing file when the observation is complete", async () => {
			const reg = new ObservationRegistry()
			reg.observe(abs("doc.txt"), "v1")
			mockedFsAccess.mockResolvedValue(undefined) // target still on disk
			mockedComputeVersionToken.mockResolvedValue("v1")
			const task = createMockTask({ observationRegistry: reg })

			await guardedWrite(task, "doc.txt", "created", "create")

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "created")
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
			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("doc.txt"), "second edit")
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("doc.txt"), "patched")
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
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, abs("shared.txt"), "first")
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, abs("shared.txt"), "second")
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
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, abs("absent.txt"), "first")
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, abs("absent.txt"), "second")
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("settle.txt"), "second")
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

			expect(mockedSafeWriteText).toHaveBeenCalledWith(abs("sub/dir.txt"), "content")
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
			expect(mockedSafeWriteText).toHaveBeenCalledWith(canonical, "content")
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
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(1, canonical, "first")
			expect(mockedSafeWriteText).toHaveBeenNthCalledWith(2, canonical, "second")
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

			expect(mockedSafeWriteText).toHaveBeenLastCalledWith(abs("x.txt"), "b")
		})
	})
})
