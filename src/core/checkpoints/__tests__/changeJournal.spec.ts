import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { appendChanges, journalPath, journalQueueDepth, loadChanges, type ChangeJournalEntry } from "../changeJournal"

// appendChange (single-entry wrapper) is production code only in B2; these
// units journal batch writes, so the spec keeps a local helper.
const appendChange = (globalStorageDir: string, taskId: string, entry: ChangeJournalEntry) =>
	appendChanges(globalStorageDir, taskId, [entry])

describe("changeJournal", () => {
	const taskId = "test-task"

	let tmpRoot: string

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "b2-journal-"))
	})

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true })
	})

	function entry(overrides: Partial<ChangeJournalEntry> = {}): ChangeJournalEntry {
		return {
			path: "src/foo.ts",
			operation: "create",
			checkpointId: "abc12345",
			...overrides,
		}
	}

	describe("appendChange", () => {
		it("writes one JSON line per entry with the documented field shape", async () => {
			await appendChange(tmpRoot, taskId, entry({ operation: "create", checkpointId: "aaa" }))

			const raw = await fs.readFile(journalPath(tmpRoot, taskId), "utf8")
			const lines = raw.split("\n").filter((line) => line !== "")
			expect(lines).toHaveLength(1)
			const parsed = JSON.parse(lines[0]) as ChangeJournalEntry
			expect(parsed.path).toBe("src/foo.ts")
			expect(parsed.operation).toBe("create")
			expect(parsed.checkpointId).toBe("aaa")
		})

		it("appends multiple entries sequentially", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "a" }))
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "b" }))

			const raw = await fs.readFile(journalPath(tmpRoot, taskId), "utf8")
			expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2)
		})

		it("rejects an append when the final record is torn instead of truncating it", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// Simulate a crash that tore the last append mid-write: the file now
			// ends with an unterminated JSON fragment. That fragment may be the
			// truncated journal record of a committed write, so the append must
			// not silently truncate it away and continue as if the history
			// were complete.
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + '{"path":"src/half.ts","operation":"upd')

			await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toThrow(
				/torn-tail recovery requires explicit repair/,
			)

			// The journal is left untouched for an explicit recovery: neither
			// the fragment was dropped nor the new entry added.
			const after = await fs.readFile(filePath, "utf8")
			expect(after).toBe(raw + '{"path":"src/half.ts","operation":"upd')
		})

		it("rejects an append when a malformed final record kept its newline", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// A final line of valid JSON that is not an entry (a bare null) is the
			// same hazard with or without its newline: accepting it here would
			// demote it to a skipped middle line after the append, so loadChanges
			// would report an incomplete rollback history as valid and
			// restore-latest could pick an older entry for the same file.
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + "null\n")

			await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toThrow(
				/final record is not a complete entry/,
			)

			// The journal is left untouched for an explicit recovery.
			const after = await fs.readFile(filePath, "utf8")
			expect(after).toBe(raw + "null\n")
		})

		it("does not insert a blank line when the journal ends cleanly", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "a" }))
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "b" }))

			const raw = await fs.readFile(journalPath(tmpRoot, taskId), "utf8")
			expect(raw).not.toContain("\n\n")
			expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2)
		})

		it("syncs the parent directory after every journal replacement (POSIX)", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const synced: string[] = []
			const closed: string[] = []
			const events: string[] = []
			// Windows cannot open directories, so the directory handle is doubled
			// here: the code under test only opens it on non-win32 platforms.
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							synced.push(p)
							events.push("sync")
						},
						close: async () => {
							closed.push(p)
						},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			const realRename = fs.rename
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				events.push("rename")
				await realRename(from as string | URL, to as string | URL)
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
				expect(synced).toEqual([dirPath])
				expect(closed).toEqual([dirPath])
				// Every replacement renames a new file into place, so the directory
				// entry is re-synced on each update. The order is part of the
				// guarantee: a directory sync that ran before the rename would not
				// have persisted the new journal file name.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "second" }))
				expect(synced).toHaveLength(2)
				expect(events).toEqual(["rename", "sync", "rename", "sync"])
			} finally {
				renameSpy.mockRestore()
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first", "second"])
		})

		it("closes the temp-file handle when its sync fails, on every platform", async () => {
			// The block-statement mutant at changeJournal.ts:192:14 replaces the
			// `finally { await handle.close() }` block with `{}`. Under the gate
			// platform (Linux) that mutant survives: an unclosed descriptor is not
			// observable through the file system there, it only leaks. So this test
			// does not infer closure from OS behaviour - it watches the handle
			// itself: the real handle is opened, then its own close() is wrapped with
			// a counter, and its sync() is made to fail. Platform-independent.
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "kept" }))
			const before = await loadChanges(tmpRoot, taskId)
			expect(before.map((e) => e.checkpointId)).toEqual(["kept"])

			const realOpen = fs.open
			let closeCalls = 0
			let tempHandleOpened = false
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const p = typeof pathish === "string" ? pathish : String(pathish)
				const handle = await realOpen(p, flags as string | undefined)
				// The only "w" open in this path is the temp journal file; the
				// directory is opened "r" (and only on POSIX). Failing sync here
				// reproduces a mid-write durability failure without touching the
				// published journal.
				if (flags === "w") {
					tempHandleOpened = true
					vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("simulated tmp sync failure"))
					const originalClose = handle.close.bind(handle)
					void vi.spyOn(handle, "close").mockImplementation(async () => {
						closeCalls++
						await originalClose()
					})
				}
				return handle
			})
			try {
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "lost" }))).rejects.toThrow(
					"simulated tmp sync failure",
				)
				// Positive control for the fixture itself: without hitting the "w"
				// handle the assertions below would pass vacuously.
				expect(tempHandleOpened).toBe(true)
				expect(closeCalls).toBe(1)
				// The rename never ran, so the journal still holds the previous
				// complete content and the temp file was cleaned up.
				const dirEntries = await fs.readdir(path.dirname(journalPath(tmpRoot, taskId)))
				expect(dirEntries.filter((name) => name.endsWith(".tmp"))).toEqual([])
				expect(dirEntries).toContain("changes.jsonl")
			} finally {
				openSpy.mockRestore()
			}
			const after = await loadChanges(tmpRoot, taskId)
			expect(after.map((e) => e.checkpointId)).toEqual(["kept"])
		})

		it("propagates a non-ENOENT journal-read failure instead of replacing blind", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// The current content cannot be read (I/O error): replacing would
			// discard whatever the unreadable journal really held, so appendChange
			// must fail loudly.
			const readSpy = vi
				.spyOn(fs, "readFile")
				.mockRejectedValueOnce(Object.assign(new Error("simulated I/O error"), { code: "EIO" }))
			try {
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toMatchObject({
					code: "EIO",
				})
			} finally {
				readSpy.mockRestore()
			}
			// The failed append wrote nothing: the next append still loads and appends.
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["good", "after"])
		})

		it("writes the full record when the underlying write completes partially", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const handle = await openAs(pathish as string | URL, flags as string | undefined)
				if (flags === "w") {
					const realWrite = handle.write.bind(handle)
					let first = true
					handle.write = (async (buf: Uint8Array, off?: number, len?: number) => {
						const length = len ?? buf.length
						if (first && length > 1) {
							first = false
							await realWrite(buf, off, 1)
							return { bytesWritten: 1, buffer: Buffer.from(buf) }
						}
						return realWrite(buf, off, length)
					}) as typeof handle.write
				}
				return handle
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "second" }))
			} finally {
				openSpy.mockRestore()
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first", "second"])
		})

		it("preserves a complete final record that lost only its newline", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// Simulate a crash that flushed a complete record but lost its
			// terminating newline: the record is entry-shaped and parseable, so
			// the repair must keep it and re-terminate instead of truncating.
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + JSON.stringify(entry({ checkpointId: "complete" })))

			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["good", "complete", "after"])
		})

		it("retries a Windows rename rejected with EPERM", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			const realRename = fs.rename
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				attempts++
				if (attempts === 1) {
					throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
				}
				await realRename(from as string | URL, to as string | URL)
			})
			try {
				// An antivirus/indexer transiently holding the destination must
				// not fail the append: the rename is retried with a short backoff.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
				expect(attempts).toBe(2)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first"])
		})

		it("does not retry a POSIX rename rejection", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attempts++
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			})
			try {
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toMatchObject({
					code: "EPERM",
				})
				expect(attempts).toBe(1)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("tolerates an unsupported directory-sync errno after the rename (POSIX)", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							throw Object.assign(new Error("EINVAL: invalid argument"), { code: "EINVAL" })
						},
						close: async () => {},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				// The rename already replaced the journal: an fsync-unsupported
				// mount must not fail the update, only reduce crash durability.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "kept" }))
				expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("directory sync unsupported"))
			} finally {
				openSpy.mockRestore()
				warnSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["kept"])
		})

		it("propagates a genuine directory-sync failure (POSIX)", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
						},
						close: async () => {},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			try {
				// A real I/O failure is not an "unsupported" case: it still
				// propagates so callers know durability is in doubt.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toMatchObject({
					code: "EIO",
				})
			} finally {
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("serializes concurrent updates to the same task", async () => {
			await Promise.all([
				appendChange(tmpRoot, taskId, entry({ checkpointId: "c1" })),
				appendChange(tmpRoot, taskId, entry({ checkpointId: "c2" })),
			])

			const result = await loadChanges(tmpRoot, taskId)
			// The queue is per-task FIFO, so write order is itself part of the
			// contract; sorting here would let a journal whose entries landed
			// out of order pass.
			expect(result.map((e) => e.checkpointId)).toEqual(["c1", "c2"])
		})

		it("leaves the journal untouched when the atomic rename fails mid-update", async () => {
			await appendChanges(tmpRoot, taskId, [entry({ checkpointId: "kept" })])
			const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated rename failure"))
			try {
				await expect(
					appendChanges(tmpRoot, taskId, [
						entry({ checkpointId: "m1", path: "src/m1.ts" }),
						entry({ checkpointId: "m2", path: "src/m2.ts" }),
					]),
				).rejects.toThrow("simulated rename failure")
			} finally {
				renameSpy.mockRestore()
			}
			// Neither of the two new entries survived: the update is all-or-nothing.
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["kept"])
			// The failed temp file was cleaned up.
			const leftovers = (await fs.readdir(path.dirname(journalPath(tmpRoot, taskId)))).filter((name) =>
				name.endsWith(".tmp"),
			)
			expect(leftovers).toEqual([])
		})

		it("rejects the append when a crash left a stale temp file and a torn tail", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "before" }))
			const dir = path.dirname(journalPath(tmpRoot, taskId))
			// A crash between the temp write and the rename leaves an orphan temp
			// file; a crash mid-write can also leave the tail unterminated. The
			// torn tail must reject the append - verified recovery is explicit.
			await fs.writeFile(path.join(dir, "changes.jsonl.4242.orphan.tmp"), "partial")
			const raw = await fs.readFile(journalPath(tmpRoot, taskId), "utf8")
			await fs.writeFile(journalPath(tmpRoot, taskId), raw + '{"path":"src/half.ts","operation":"upd')

			await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toThrow(
				/torn-tail recovery requires explicit repair/,
			)
		})

		it("recovers after a crash left a stale temp file with a clean tail", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "before" }))
			const dir = path.dirname(journalPath(tmpRoot, taskId))
			// An orphan temp file alone is harmless: the rename never happened,
			// and the journal tail is complete, so the append proceeds.
			await fs.writeFile(path.join(dir, "changes.jsonl.4242.orphan.tmp"), "partial")

			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["before", "after"])
		})

		it("does not create a journal for an empty update", async () => {
			await appendChanges(tmpRoot, taskId, [])
			await expect(fs.stat(journalPath(tmpRoot, taskId))).rejects.toMatchObject({ code: "ENOENT" })
		})
		it("writes both entries of a successful multi-entry batch in order", async () => {
			// Production journals batch writes through appendChanges, so the batch
			// shape must land every entry in order, not only the single-entry wrapper.
			await appendChanges(tmpRoot, taskId, [
				entry({ checkpointId: "m1", path: "src/m1.ts" }),
				entry({ checkpointId: "m2", path: "src/m2.ts" }),
			])
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["m1", "m2"])
			expect(result.map((e) => e.path)).toEqual(["src/m1.ts", "src/m2.ts"])
		})

		it("round-trips every journal operation value", async () => {
			// The validator admits exactly these three operations; pinning only the one
			// the helper defaults to would let the other two rot silently.
			for (const operation of ["create", "update", "delete"] as const) {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "op-" + operation, operation }))
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.operation)).toEqual(["create", "update", "delete"])
		})

		it("rejects an append when the existing final record has wrongly typed fields", async () => {
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			await fs.mkdir(dirPath, { recursive: true })
			await fs.writeFile(
				journalPath(tmpRoot, taskId),
				JSON.stringify({ path: 123, operation: "create", checkpointId: "old" }) + "\n",
			)
			await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toThrow(
				/final record is not a complete entry/,
			)
		})

		it("appends to a journal file that exists but is empty", async () => {
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			await fs.mkdir(dirPath, { recursive: true })
			await fs.writeFile(journalPath(tmpRoot, taskId), "")
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first"])
		})

		it("separates an unterminated tail from a malformed one in the rejection", async () => {
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			await fs.mkdir(dirPath, { recursive: true })
			const messageOf = async (run: Promise<unknown>): Promise<string> =>
				run.then(
					() => "",
					(error: unknown) => String((error as { message?: string }).message ?? ""),
				)
			// A fragment with no trailing newline is reported as unterminated.
			await fs.writeFile(journalPath(tmpRoot, taskId), '{"path": 1, "operation": "create"}')
			const unterminated = await messageOf(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" })))
			expect(unterminated).toContain("unterminated")
			await fs.writeFile(journalPath(tmpRoot, taskId), '{"path": 1, "operation": "create"}\n')
			const terminated = await messageOf(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" })))
			expect(terminated).toContain("final record is not a complete entry")
			expect(terminated).not.toContain("unterminated")
			// The suffix is part of the operator-facing contract, so pin the whole
			// message rather than only its prefix.
			expect(terminated).toBe(
				`Cannot append to change journal ${journalPath(tmpRoot, taskId)}: final record is not a complete entry (torn-tail recovery requires explicit repair)`,
			)
		})

		it.each([
			["EBUSY", "ebusy"],
			["EACCES", "eacces"],
		])("retries a Windows rename rejected with %s", async (code: string, id: string) => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			const realRename = fs.rename
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				attempts++
				if (attempts === 1) {
					throw Object.assign(new Error(code + ": transient failure"), { code })
				}
				await realRename(from as string | URL, to as string | URL)
			})
			try {
				// Transient holds on the destination are retried for every errno on the
				// list, not only for the one the first test happened to use.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: id }))
				expect(attempts).toBe(2)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual([id])
		})

		it("gives up retrying a Windows rename after five attempts and reports the original error", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attempts++
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			})
			try {
				// The retry budget is finite and the counter moves upward: a permanently
				// held destination must fail the append instead of looping forever.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toMatchObject({
					code: "EPERM",
				})
				expect(attempts).toBe(5)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("propagates a rename failure that carries no errno code", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attempts++
				throw new Error("rename rejected by an unforeseen error")
			})
			try {
				// A failure without a code property is not on the retry list on any
				// platform, so it must surface on the first attempt.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toThrow(
					"rename rejected by an unforeseen error",
				)
				expect(attempts).toBe(1)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("propagates a Windows rename failure that carries no errno code without retrying", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attempts++
				throw new Error("rename rejected by an unforeseen error")
			})
			try {
				// The Linux variant above never reaches the errno filter: the
				// attempt budget rejects first. On win32 the retry decision does
				// consult the code list, so a code-less failure must surface
				// intact without spending the five-attempt budget.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toThrow(
					"rename rejected by an unforeseen error",
				)
				expect(attempts).toBe(1)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("propagates a directory-sync failure that carries no errno code", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							throw new Error("sync failed for an unforeseen reason")
						},
						close: async () => {},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			try {
				// An errno-less failure is not an "unsupported mount" either.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toThrow(
					"sync failed for an unforeseen reason",
				)
			} finally {
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})

		it("tolerates every errno the directory-sync guard treats as unsupported (POSIX)", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			let currentCode = "EINVAL"
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							throw Object.assign(new Error(currentCode + ": unsupported"), { code: currentCode })
						},
						close: async () => {},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const tolerated = ["EINVAL", "EISDIR", "EBADF", "ENOTSUP", "EOPNOTSUPP", "EPERM"] as const
			try {
				// Every name on the tolerance list must be tolerated, not only the first.
				for (const code of tolerated) {
					currentCode = code
					await appendChange(tmpRoot, taskId, entry({ checkpointId: "tol-" + code }))
					expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("directory sync unsupported"))
				}
				expect(warnSpy).toHaveBeenCalledTimes(tolerated.length)
			} finally {
				openSpy.mockRestore()
				warnSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(tolerated.map((code) => "tol-" + code))
		})

		it("skips the directory sync on win32 instead of failing on it", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const dirOpens: string[] = []
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					dirOpens.push(p)
					throw Object.assign(new Error("EPERM: windows cannot open directories"), { code: "EPERM" })
				}
				return openAs(p, flags as string | undefined)
			})
			try {
				// Windows cannot open a directory handle at all, so the update must land
				// without ever attempting the directory sync.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "onwin" }))
				expect(dirOpens).toEqual([])
			} finally {
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["onwin"])
		})
		it("appends to a journal that contains nothing but a newline", async () => {
			// A lone newline leaves an empty tail rather than an empty file, so the
			// tail check must be skipped instead of parsing an empty string.
			const dirPath = path.dirname(journalPath(tmpRoot, taskId))
			await fs.mkdir(dirPath, { recursive: true })
			await fs.writeFile(journalPath(tmpRoot, taskId), "\n")
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after-blank" }))
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["after-blank"])
		})

		it("does not retry a POSIX rename rejected with an errno on the retry list", async () => {
			const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			let attempts = 0
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
				attempts++
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			})
			try {
				// The retry budget is the platform decision: a POSIX rename failure
				// fails on the first attempt even when its errno is on the retry list.
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))).rejects.toMatchObject({
					code: "EPERM",
				})
				expect(attempts).toBe(1)
			} finally {
				renameSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
		})
	})

	describe("task ID containment", () => {
		it("rejects task IDs that could escape the tasks directory", async () => {
			// A storage root owned by this test, nested inside the fixture: the
			// escape destination then lands under tmpRoot instead of a sibling
			// of it that every other test in the run shares and that may
			// already exist.
			const parent = path.join(tmpRoot, "containment")
			for (const bad of ["../../outside", "a/b", "a\\b", "", ".", ".."]) {
				expect(() => journalPath(parent, bad)).toThrow(/Unsafe task ID/)
				await expect(appendChange(parent, bad, entry({ checkpointId: "x" }))).rejects.toThrow(/Unsafe task ID/)
				await expect(loadChanges(parent, bad)).rejects.toThrow(/Unsafe task ID/)
			}
			// The exact directory the "../.." id would have written through is
			// tmpRoot/outside; asserted as the destination, not a shared path.
			await expect(fs.stat(path.join(tmpRoot, "outside"))).rejects.toMatchObject({ code: "ENOENT" })
			// And nothing was created under the storage root at all.
			await expect(fs.readdir(parent)).rejects.toMatchObject({ code: "ENOENT" })
		})

		it("keeps a safe task ID under the tasks directory", () => {
			expect(journalPath(tmpRoot, "task-42")).toBe(
				path.join(tmpRoot, "tasks", "task-42", "checkpoints", "changes.jsonl"),
			)
		})
	})

	describe("loadChanges", () => {
		it("returns [] for an absent journal file", async () => {
			expect(await loadChanges(tmpRoot, taskId)).toEqual([])
		})

		it("returns [] for an empty journal file", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			await fs.writeFile(journalPath(tmpRoot, taskId), "")

			expect(await loadChanges(tmpRoot, taskId)).toEqual([])
		})

		it("propagates non-ENOENT read failures instead of reporting an empty journal", async () => {
			// A directory at the journal path makes readFile fail with EISDIR —
			// a stand-in for any permission or I/O failure (EACCES etc.). Such a
			// failure must not be swallowed into "no changes": it would let a
			// rollback report a no-op success without reading the history.
			await fs.mkdir(journalPath(tmpRoot, taskId), { recursive: true })

			await expect(loadChanges(tmpRoot, taskId)).rejects.toMatchObject({ code: "EISDIR" })
		})

		it("parses all entries in order with a clean tail", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "x" }))
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "y" }))
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "z" }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result).toHaveLength(3)
			expect(result[0].checkpointId).toBe("x")
			expect(result[1].checkpointId).toBe("y")
			expect(result[2].checkpointId).toBe("z")
		})

		it("parses a journal whose final line has no trailing newline", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "ok" }))

			// Rewrite the file without the trailing newline of the last line.
			const filePath = journalPath(tmpRoot, taskId)
			const content = (await fs.readFile(filePath, "utf8")).replace(/\n$/, "")
			await fs.writeFile(filePath, content)

			const result = await loadChanges(tmpRoot, taskId)
			expect(result).toHaveLength(1)
			expect(result[0].checkpointId).toBe("ok")
		})

		it("rejects a torn final line instead of silently dropping it", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "ok" }))

			// Append a second line truncated mid-content, with no trailing
			// newline. Without verified truncation there is no evidence this
			// is a crash tail rather than a corrupted record, and silently
			// dropping it would report an incomplete history as valid.
			await fs.appendFile(journalPath(tmpRoot, taskId), '{"path":"src/half.ts","operation":"upd')

			await expect(loadChanges(tmpRoot, taskId)).rejects.toThrow(/Corrupt change journal entry at line 2/)
		})

		it("skips a corrupt middle line and still loads the later valid entries", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "ok" }))

			// Corrupt the first line in place, then append a valid entry after it.
			await fs.writeFile(
				journalPath(tmpRoot, taskId),
				'"{"path":"src/corrupt.ts","operation":"update"\n' +
					JSON.stringify(entry({ checkpointId: "after" })) +
					"\n",
			)

			const result = await loadChanges(tmpRoot, taskId)
			expect(result).toHaveLength(1)
			expect(result[0].checkpointId).toBe("after")
		})
		it("rejects a final line that parses but is not entry-shaped", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// A final line of valid JSON that is not an entry (a bare null, a
			// bare number, a differently-shaped object) is the same
			// unverified-tail hazard as an unparseable one: silently dropping
			// it reports an incomplete rollback history as valid and lets
			// restore-latest pick an older entry for the same file.
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + "null\n")

			await expect(loadChanges(tmpRoot, taskId)).rejects.toThrow(/Malformed change journal entry at line 2/)
		})

		it("skips a middle line that parses but is not entry-shaped", async () => {
			// Lineage: a wrong-shaped line before the final line is skipped so
			// later valid entries stay readable; only the final line rejects.
			const filePath = journalPath(tmpRoot, taskId)
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(
				filePath,
				JSON.stringify(entry({ checkpointId: "a" })) +
					"\n" +
					"null\n" +
					JSON.stringify(entry({ checkpointId: "b" })) +
					"\n",
			)

			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["a", "b"])
		})

		it("rejects a journal whose only record is torn", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))

			// Truncate to a single character — definitely invalid JSON. The
			// append path rejects such a tail on the next write; a read must
			// not report the lost record as a complete (empty) history.
			await fs.writeFile(journalPath(tmpRoot, taskId), "{")

			await expect(loadChanges(tmpRoot, taskId)).rejects.toThrow(/Corrupt change journal entry at line 1/)
		})

		it("includes diffStats when present", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "s", diffStats: { additions: 5, deletions: 2 } }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result[0].diffStats).toEqual({ additions: 5, deletions: 2 })
		})

		it("omits diffStats when not provided", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "n" }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result[0].diffStats).toBeUndefined()
		})
		it("returns [] for a journal that contains only whitespace", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			await fs.writeFile(journalPath(tmpRoot, taskId), "   \n  \n")
			expect(await loadChanges(tmpRoot, taskId)).toEqual([])
		})

		it("skips a middle line whose fields have the wrong types and keeps the valid entries", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			const good1 = JSON.stringify(entry({ checkpointId: "good1" }))
			const wrongType = JSON.stringify({ path: 7, operation: "create", checkpointId: "weird" })
			const good2 = JSON.stringify(entry({ checkpointId: "good2" }))
			await fs.writeFile(journalPath(tmpRoot, taskId), [good1, wrongType, good2].join("\n") + "\n")
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["good1", "good2"])
		})

		it("rejects a final line that parses with the wrong field types", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			const good = JSON.stringify(entry({ checkpointId: "good" }))
			const wrongType = JSON.stringify({ path: "src/foo.ts", operation: "create", checkpointId: 42 })
			await fs.writeFile(journalPath(tmpRoot, taskId), good + "\n" + wrongType + "\n")
			await expect(loadChanges(tmpRoot, taskId)).rejects.toThrow(/Malformed change journal entry at line 2/)
		})
	})

	describe("journal queue lifecycle", () => {
		it("prunes the per-task queue entry once the update settles", async () => {
			const before = journalQueueDepth()

			await appendChange(tmpRoot, taskId, entry({ checkpointId: "settled" }))
			// The pruning hook runs one microtask after the caller's promise
			// settles; drain it before asserting.
			await new Promise((resolve) => setImmediate(resolve))
			expect(journalQueueDepth()).toBe(before)

			// In-flight updates hold their entries; settled ones prune again.
			const first = appendChange(tmpRoot, taskId, entry({ checkpointId: "one" }))
			const second = appendChange(tmpRoot, "other-task", entry({ checkpointId: "two" }))
			expect(journalQueueDepth()).toBe(before + 2)
			await Promise.all([first, second])
			await new Promise((resolve) => setImmediate(resolve))
			expect(journalQueueDepth()).toBe(before)
		})
		it("keeps a newer queued update when an earlier one settles", async () => {
			// Each gate is created before the code under test runs, so releasing it
			// later cannot race the moment the mocked rename reaches the gate.
			const makeGate = (): { release: () => void; wait: () => Promise<void> } => {
				let settle = (): void => {}
				const promise = new Promise<void>((resolve) => {
					settle = () => resolve()
				})
				return {
					release: () => settle(),
					wait: () => promise,
				}
			}
			const firstGate = makeGate()
			const secondGate = makeGate()
			let gateCount = 0
			const realRename = fs.rename
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				gateCount++
				if (gateCount === 1) {
					await firstGate.wait()
				} else if (gateCount === 2) {
					await secondGate.wait()
				}
				await realRename(from as string | URL, to as string | URL)
			})
			const before = journalQueueDepth()
			let first: Promise<void> = Promise.resolve()
			let second: Promise<void> = Promise.resolve()
			try {
				first = appendChange(tmpRoot, taskId, entry({ checkpointId: "slow" }))
				second = appendChange(tmpRoot, taskId, entry({ checkpointId: "newer" }))
				expect(journalQueueDepth()).toBe(before + 1)
				firstGate.release()
				await first
				// The pruning hook runs one microtask after the caller promise settles.
				await new Promise((resolve) => setImmediate(resolve))
				// The earlier update has settled while the newer one is still queued:
				// pruning is keyed to the queue tail, so it must not drop the newer entry.
				expect(journalQueueDepth()).toBe(before + 1)
				secondGate.release()
				await second
				await new Promise((resolve) => setImmediate(resolve))
				expect(journalQueueDepth()).toBe(before)
			} finally {
				// Release both gates and settle both appends before restoring the
				// spy: if a depth assertion above fails, the second update must
				// not still be mid-rename when afterEach removes tmpRoot.
				firstGate.release()
				secondGate.release()
				await Promise.allSettled([first, second])
				renameSpy.mockRestore()
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["slow", "newer"])
		})
	})

	describe("behavior probed against the 2026-11-25 review findings", () => {
		it("loadChanges keeps a string-typed diffStats exactly as written", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			const withStats = JSON.stringify({
				path: "src/a.ts",
				operation: "create",
				checkpointId: "s1",
				diffStats: { additions: "5", deletions: 2 },
			})
			await fs.writeFile(journalPath(tmpRoot, taskId), withStats + "\n")
			const result = await loadChanges(tmpRoot, taskId)
			// Predicted by the finding: isEntryShaped ignores diffStats, so an
			// untyped stats object survives the load unchanged.
			expect(JSON.stringify(result)).toContain('"additions":"5"')
		})

		it("appendChanges tolerates a blank line after a valid final record", async () => {
			await fs.mkdir(path.dirname(journalPath(tmpRoot, taskId)), { recursive: true })
			const good = JSON.stringify(entry({ checkpointId: "good" }))
			await fs.writeFile(journalPath(tmpRoot, taskId), good + "\n\n")
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))
			const result = await loadChanges(tmpRoot, taskId)
			// Predicted by the finding: append skips tail validation on an
			// empty tailText, and the blank line then reads as a skippable
			// middle record, so both ids come back.
			expect(result.map((e) => e.checkpointId)).toEqual(["good", "after"])
		})

		it("appendChanges reads the caller array after the queue turn", async () => {
			const batch = [entry({ checkpointId: "b1" })]
			const pending = appendChanges(tmpRoot, taskId, batch)
			batch.push(entry({ checkpointId: "b2" }))
			await pending
			const result = await loadChanges(tmpRoot, taskId)
			// Predicted by the finding: the batch is joined only after the
			// queue await, so a caller that mutates the array is journalled.
			expect(result.map((e) => e.checkpointId)).toEqual(["b1", "b2"])
		})
	})
})
