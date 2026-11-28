import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	appendChange,
	incompleteJournalPath,
	journalPath,
	loadChanges,
	pendingJournalPath,
	writeIncompleteJournal,
	writePendingJournal,
	type ChangeJournalEntry,
} from "../changeJournal"

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
		it("fsyncs the containing directory when the append creates the journal file", async () => {
			const opened: string[] = []
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				opened.push(String(pathish))
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				return openAs(pathish as string | URL, flags as string | undefined)
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
			} finally {
				openSpy.mockRestore()
			}
			// The creation path must sync the journal's parent directory so the new
			// file's directory entry (and any directory fs.mkdir just created)
			// survives a crash before the append is reported as committed.
			expect(opened).toContain(path.dirname(journalPath(tmpRoot, taskId)))
		})

		it("does not re-open the directory for appends to an existing journal", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
			const dir = path.dirname(journalPath(tmpRoot, taskId))
			const opened: string[] = []
			const realOpen = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				opened.push(String(pathish))
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				return openAs(pathish as string | URL, flags as string | undefined)
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "second" }))
			} finally {
				openSpy.mockRestore()
			}
			// The directory entry is already durable; re-syncing on every append
			// would add a syscall to the hot path for no durability gain.
			expect(opened).not.toContain(dir)
		})

		it("tolerates platforms where the journal directory cannot be synced", async () => {
			const dir = path.dirname(journalPath(tmpRoot, taskId))
			const realOpen = fs.open
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				if (String(pathish) === dir) {
					throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
				}
				const openAs = realOpen as (p: string | URL, f?: string) => Promise<fs.FileHandle>
				return openAs(pathish as string | URL, flags as string | undefined)
			})
			try {
				await appendChange(tmpRoot, taskId, entry({ checkpointId: "first" }))
			} finally {
				openSpy.mockRestore()
				warnSpy.mockRestore()
			}
			// The entry itself is durable via the file sync; the platform without
			// directory sync degrades to a warning instead of failing the append.
			const result = await loadChanges(tmpRoot, taskId)
			expect(result.map((e) => e.checkpointId)).toEqual(["first"])
		})
	})

	describe("marker durability (the two staging+rename writers)", () => {
		const markerEntry: ChangeJournalEntry = { path: "src/foo.ts", operation: "create", checkpointId: "abc12345" }

		/**
		 * Replace fs/promises.open with a double that labels every handle by what it is for
		 * (a ".staging" file gets "content", anything else is the containing "directory") and
		 * records the order of open / sync / rename. The three journal writers only ever use
		 * write, sync and close on a handle, so the double implements exactly those three and
		 * delegates them to the real handle - the durability being asserted is the order the
		 * writers call them in, which is what a crash actually leaves behind.
		 */
		function instrument(eventList: string[]) {
			const realOpen = fs.open
			const realRename = fs.rename
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				const openAs = realOpen as (p: string | URL, f?: string | number) => Promise<fs.FileHandle>
				const handle = await openAs(pathish as string | URL, flags as string | number | undefined)
				const label = String(pathish).endsWith(".staging") ? "content" : "directory"
				eventList.push("open:" + label)
				const double = {
					write: (data: Buffer, offset?: number, length?: number) => handle.write(data, offset, length),
					sync: async () => {
						eventList.push("sync:" + label)
						return handle.sync()
					},
					close: () => handle.close(),
				} as unknown as fs.FileHandle
				return double
			})
			const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (fromish, toish) => {
				eventList.push("rename")
				return realRename(fromish, toish)
			})
			return () => {
				openSpy.mockRestore()
				renameSpy.mockRestore()
			}
		}

		it("syncs the staged pending marker before renaming it into place", async () => {
			const events: string[] = []
			const restore = instrument(events)
			try {
				await writePendingJournal(tmpRoot, taskId, { state: "ready", createdAt: 1, entries: [markerEntry] })
			} finally {
				restore()
			}
			// Counted before ordered, so a writer that syncs nothing fails with a count
			// message rather than an index comparison against -1.
			expect(events.filter((e) => e === "open:content")).toHaveLength(1)
			expect(events.filter((e) => e === "sync:content")).toHaveLength(1)
			expect(events.filter((e) => e === "rename")).toHaveLength(1)
			// Renaming an un-synced staging file is the whole durability question: the
			// rename can land in a different order from the content it carries.
			expect(events.indexOf("sync:content")).toBeLessThan(events.indexOf("rename"))
			// The marker itself is still written, so the durability work changed nothing
			// about the state the recovery reader classifies.
			const marker = JSON.parse(await fs.readFile(pendingJournalPath(tmpRoot, taskId), "utf8"))
			expect(marker).toEqual({ state: "ready", createdAt: 1, entries: [markerEntry] })
		})

		it("syncs the containing directory after the rename so the marker entry survives", async () => {
			const events: string[] = []
			const restore = instrument(events)
			try {
				await writePendingJournal(tmpRoot, taskId, { state: "awaiting-checkpoint", createdAt: 1 })
			} finally {
				restore()
			}
			// The marker's directory entry is what makes the marker findable after a
			// crash, and the writer creates that directory itself, so the directory must
			// be synced once, after the rename that first publishes the marker.
			expect(events.filter((e) => e === "open:directory")).toHaveLength(1)
			expect(events.filter((e) => e === "sync:directory")).toHaveLength(1)
			expect(events.indexOf("rename")).toBeLessThan(events.indexOf("sync:directory"))
		})

		it("tolerates platforms that cannot sync the marker directory", async () => {
			const dir = path.dirname(pendingJournalPath(tmpRoot, taskId))
			const realOpen = fs.open
			// Captured locally rather than read back from the spy: mockRestore() clears a
			// spy's call history, and this test restores before it asserts.
			const warnings: string[] = []
			const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
				warnings.push(String(args[0]))
			})
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathish, flags) => {
				if (String(pathish) === dir) {
					throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
				}
				const openAs = realOpen as (p: string | URL, f?: string | number) => Promise<fs.FileHandle>
				return openAs(pathish as string | URL, flags as string | number | undefined)
			})
			try {
				await writePendingJournal(tmpRoot, taskId, { state: "ready", createdAt: 1, entries: [markerEntry] })
			} finally {
				openSpy.mockRestore()
				warnSpy.mockRestore()
			}
			// A platform without directory sync degrades to a warning; the marker itself
			// is durable through the content sync and must still be readable.
			const marker = JSON.parse(await fs.readFile(pendingJournalPath(tmpRoot, taskId), "utf8"))
			expect(marker.state).toBe("ready")
			expect(warnings.some((w) => w.includes("directory sync unsupported"))).toBe(true)
		})

		it("syncs the staged incomplete marker before replacing the marker file", async () => {
			const events: string[] = []
			const restore = instrument(events)
			try {
				await writeIncompleteJournal(tmpRoot, taskId, [markerEntry])
			} finally {
				restore()
			}
			expect(events.filter((e) => e === "sync:content")).toHaveLength(1)
			expect(events.filter((e) => e === "rename")).toHaveLength(1)
			expect(events.indexOf("sync:content")).toBeLessThan(events.indexOf("rename"))
			// Same directory guarantee as the pending marker: this file is the recovery
			// record for a committed checkpoint whose entries never made the journal.
			expect(events.filter((e) => e === "sync:directory")).toHaveLength(1)
			expect(events.indexOf("rename")).toBeLessThan(events.indexOf("sync:directory"))
			const marker = JSON.parse(await fs.readFile(incompleteJournalPath(tmpRoot, taskId), "utf8"))
			expect(marker).toEqual({ entries: [markerEntry] })
		})
	})

	describe("incomplete marker preservation", () => {
		it("preserves the entries of an existing incomplete marker instead of replacing them", async () => {
			// rename replaces its destination, and the only reader that folds this marker
			// back is reconcileIncompleteJournal, reached from loadChanges. Two failed
			// ready-promotions in the same session, with no load between them, therefore
			// used to lose the first batch: the second write replaced the first marker.
			await writeIncompleteJournal(tmpRoot, taskId, [entry({ checkpointId: "first" })])
			await writeIncompleteJournal(tmpRoot, taskId, [entry({ checkpointId: "second", path: "src/bar.ts" })])
			await writeIncompleteJournal(tmpRoot, taskId, [entry({ checkpointId: "first" })])

			const entries = await loadChanges(tmpRoot, taskId)
			// First-seen order is what is preserved: the earlier marker's entries keep
			// their positions, later batches are appended in their own order, and a
			// repeated key is not written twice.
			expect(entries.map((e) => e.checkpointId)).toEqual(["first", "second"])
			expect(entries.map((e) => e.path)).toEqual(["src/foo.ts", "src/bar.ts"])
			// The read still consumes the marker once every entry is durable.
			await expect(fs.stat(incompleteJournalPath(tmpRoot, taskId))).rejects.toMatchObject({ code: "ENOENT" })
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

		it("propagates a non-ENOENT failure from loadChanges instead of reporting an empty history", async () => {
			await appendChange(tmpRoot, taskId, entry({ checkpointId: "good" }))
			// A transient read failure is not an empty rollback history: a
			// restore that saw [] would report a no-op success without ever
			// reading the real entries (appendChange already propagates
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
	})
})
