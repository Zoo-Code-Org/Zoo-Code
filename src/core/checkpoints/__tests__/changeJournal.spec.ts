import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { appendChange, journalPath, loadChanges, type ChangeJournalEntry } from "../changeJournal"

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

		it("repairs a torn tail before appending so both entries load", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// Simulate a crash that tore the last append mid-write: the file now
			// ends with an unterminated JSON fragment.
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + '{"path":"src/half.ts","operation":"upd')

			await appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))

			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["good", "after"])
		})

		it("does not insert a blank line when the journal ends cleanly", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "a" }))
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "b" }))

			const raw = await fs.readFile(journalPath(tmpRoot, taskId), "utf8")
			expect(raw).not.toContain("\n\n")
			expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2)
		})

		it("syncs the parent directory after the first append creates the journal (POSIX)", async () => {
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
				// Subsequent appends do not re-sync the directory.
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "second" }))
				expect(synced).toHaveLength(1)
			} finally {
				openSpy.mockRestore()
				if (platformDesc) Object.defineProperty(process, "platform", platformDesc)
			}
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first", "second"])
		})

		it("propagates a non-ENOENT tail-inspection failure instead of appending blind", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			const filePath = journalPath(tmpRoot, taskId)
			const raw = await fs.readFile(filePath, "utf8")
			await fs.writeFile(filePath, raw + '{"path":"src/half.ts","operation":"upd')
			// The tail cannot be inspected (I/O error): appending would merge the
			// new entry into the fragment, so appendChange must fail loudly.
			const statSpy = vi
				.spyOn(fs, "stat")
				.mockRejectedValueOnce(Object.assign(new Error("simulated I/O error"), { code: "EIO" }))
			try {
				await expect(appendChange(tmpRoot, taskId, entry({ checkpointId: "after" }))).rejects.toMatchObject({
					code: "EIO",
				})
			} finally {
				statSpy.mockRestore()
			}
			// The failed append wrote nothing: the next append still repairs and loads.
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
				if (flags === "a") {
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

		it("discards a torn final line and returns the complete entries", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "ok" }))

			// Append a second line truncated mid-content, with no trailing newline.
			await fs.appendFile(journalPath(tmpRoot, taskId), '{"path":"src/half.ts","operation":"upd')

			const result = await loadChanges(tmpRoot, taskId)
			expect(result).toHaveLength(1)
			expect(result[0].checkpointId).toBe("ok")
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

		it("does not throw when the entire journal is torn", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))

			// Truncate to a single character — definitely invalid JSON.
			await fs.writeFile(journalPath(tmpRoot, taskId), "{")

			expect(await loadChanges(tmpRoot, taskId)).toEqual([])
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
