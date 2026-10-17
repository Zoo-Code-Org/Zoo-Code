import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { appendChange, appendChanges, journalPath, loadChanges, type ChangeJournalEntry } from "../changeJournal"

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
			// Windows cannot open directories, so the directory handle is doubled
			// here: the code under test only opens it on non-win32 platforms.
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				const p = typeof pathish === "string" ? pathish : String(pathish)
				if (p === dirPath && flags === "r") {
					return {
						sync: async () => {
							synced.push(p)
						},
						close: async () => {
							closed.push(p)
						},
					} as unknown as fs.FileHandle
				}
				return openAs(p, flags as string | undefined)
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
				expect(synced).toEqual([dirPath])
				expect(closed).toEqual([dirPath])
				// Every replacement renames a new file into place, so the directory
				// entry is re-synced on each update.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "second" }))
				expect(synced).toHaveLength(2)
			} finally {
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first", "second"])
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
			// The failed append wrote nothing: the next append still repairs and loads.
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["good", "after"])
		})

		it("propagates a non-ENOENT failure from loadChanges instead of reporting an empty history", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// A transient read failure is not an empty rollback history: a
			// restore that saw [] would report a no-op success without ever
			// reading the real entries (appendChanges already propagates
			// non-ENOENT errors; the loader must agree).
			const readSpy = vi
				.spyOn(fs, "readFile")
				.mockRejectedValueOnce(Object.assign(new Error("simulated I/O error"), { code: "EIO" }))
			try {
				await expect(loadChanges(tmpRoot, taskId)).rejects.toMatchObject({ code: "EIO" })
			} finally {
				readSpy.mockRestore()
			}
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
			expect(result.map((e) => e.checkpointId).sort()).toEqual(["c1", "c2"])
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
	})

	describe("task ID containment", () => {
		it("rejects task IDs that could escape the tasks directory", async () => {
			for (const bad of ["../../outside", "a/b", "a\\b", "", ".", ".."]) {
				expect(() => journalPath(tmpRoot, bad)).toThrow(/Unsafe task ID/)
				await expect(appendChange(tmpRoot, bad, entry({ checkpointId: "x" }))).rejects.toThrow(/Unsafe task ID/)
				await expect(loadChanges(tmpRoot, bad)).rejects.toThrow(/Unsafe task ID/)
				// Nothing was created outside the task directory.
				await expect(fs.stat(path.join(tmpRoot, "..", "outside"))).rejects.toMatchObject({ code: "ENOENT" })
			}
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
			// append path repairs such a tail on the next write; a read must
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
	})
})
