import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { acquireFileLock } from "../fileLock"
import { setPersistenceTraceSink } from "../../core/task-persistence/persistenceTrace"
import { deleteJsonFile, recoverMissingJsonFile } from "../jsonFileRecovery"
import { readFileWithMissingRetry } from "../../core/task-persistence/readFileWithMissingRetry"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readdir: vi.fn(actual.readdir), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

describe("reader recovery", () => {
	let dir: string
	let target: string
	let backup: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-reader-recovery-"))
		target = path.join(dir, "history_item.json")
		backup = path.join(dir, ".history_item.json.bak_1_saved.tmp")
		await fs.writeFile(backup, JSON.stringify({ committed: true }))
	})
	afterEach(async () => {
		setPersistenceTraceSink(undefined)
		vi.restoreAllMocks()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it.each(["hint-scan", "locked-scan", "restore"] as const)(
		"preserves history after a failed %s and recovers on retry",
		async (step) => {
			const sink = vi.fn()
			setPersistenceTraceSink(sink)
			const error = Object.assign(new Error("Private filesystem detail"), { code: "EIO" })
			if (step === "restore") vi.mocked(fs.rename).mockRejectedValueOnce(error)
			else {
				if (step === "locked-scan") {
					const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
					vi.mocked(fs.readdir).mockImplementationOnce(actual.readdir)
				}
				vi.mocked(fs.readdir).mockRejectedValueOnce(error)
			}
			await expect(readFileWithMissingRetry(target)).rejects.toBe(error)
			expect(sink).toHaveBeenCalledWith(expect.stringContaining('"result":"failed"'))
			expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
			await expect(fs.readFile(target)).rejects.toMatchObject({ code: "ENOENT" })
			expect(JSON.parse(await readFileWithMissingRetry(target))).toEqual({ committed: true })
		},
	)

	it("rechecks the canonical file under lock and never replaces a newer commit with a stale backup", async () => {
		await fs.writeFile(target, JSON.stringify({ newest: true }))
		await recoverMissingJsonFile(target)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ newest: true })
		await expect(fs.readFile(backup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("traces reader restoration and lock waiting", async () => {
		const sink = vi.fn()
		setPersistenceTraceSink(sink)
		await readFileWithMissingRetry(target)
		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"stage":"json-lock-wait"'))
		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"result":"restored"'))
	})

	it("does not steal a live writer lock during startup recovery", async () => {
		const release = await acquireFileLock(target)
		try {
			await expect(recoverMissingJsonFile(target, { waitForStaleLock: false })).rejects.toMatchObject({
				code: "ELOCKED",
			})
			expect(await fs.readFile(backup, "utf8")).toContain("committed")
			await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await release()
		}
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
	})

	it("returns false when only an uncommitted replacement exists", async () => {
		await fs.rename(backup, path.join(dir, ".history_item.json.new_1.tmp"))
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
	})

	it("deletes backups before the canonical file and prevents resurrection", async () => {
		await fs.writeFile(target, "{}")
		await deleteJsonFile(target)
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(deleteJsonFile(target)).resolves.toBeUndefined()
	})

	it("preserves the canonical file when deleting a backup fails", async () => {
		await fs.writeFile(target, "committed")
		const error = Object.assign(new Error("unlink failed"), { code: "EACCES" })
		vi.mocked(fs.unlink).mockRejectedValueOnce(error)
		await expect(deleteJsonFile(target)).rejects.toBe(error)
		expect(await fs.readFile(target, "utf8")).toBe("committed")
		await expect(fs.access(backup)).resolves.toBeUndefined()
	})

	it("does not create a missing task directory", async () => {
		await fs.rm(dir, { recursive: true })
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" })
	})
})

describe("replacement leftover name patterns", () => {
	let dir: string
	let target: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-recovery-names-"))
		target = path.join(dir, "a.json")
		await fs.writeFile(target, JSON.stringify({ committed: true }))
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(dir, { recursive: true, force: true })
	})

	// The three names recovery accepts. The first two are the staging and backup
	// names safeWriteJson used before it published through safeWriteText; the third
	// is the name safeWriteText requires of a caller-staged file (.new_*.tmp), with
	// this file's basename embedded after the anchor so the name stays scoped.
	it.each([".a.json.new_1_legacy.tmp", ".a.json.bak_1_legacy.tmp", ".new_a.json_1_staged.tmp"])(
		"garbage collects the accepted leftover named %s when the canonical file exists",
		async (name: string) => {
			const leftover = path.join(dir, name)
			await fs.writeFile(leftover, "stale")
			await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
			await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	// The tail rule is deliberately not uniform across the prefixes, and core/task-persistence/
	// __tests__/TaskHistoryStore.realConcurrency.spec.ts is the reason it may not be: that spec plants
	// `.history_item.json.bak_1.tmp`, a backup from before writers appended a random token, and
	// migration must still recover it. The dot-anchored prefix already pins this file's basename
	// through the literal dot before the kind, so the token stays optional there.
	it("collects a timestamp-only backup name under the dot-anchored prefix", async () => {
		const leftover = path.join(dir, ".a.json.bak_1.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// The other half of the same rule: on the underscore-anchored staged prefix the token is the only
	// thing that attributes a staged-looking name to this target, so the very same tail shape there
	// is somebody else's in-flight file and must survive.
	// The token a writer can actually be handed: Math.random() === 0 stringifies to "0", so
	// substring(2) answers the empty string and the name ends timestamp-underscore-dot-tmp (measured
	// with node 22.23.4). Under the dot-anchored prefix that name is still this target's own leftover -
	// the literal dot already pins the basename - so recovery has to take it.
	it("collects a dot-anchored backup whose random token came out empty", async () => {
		const leftover = path.join(dir, ".a.json.bak_1730000000000_.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// The same name on the reader's restore path, which is the half the rows above leave untested: with the
	// target gone the empty-token backup has to be what the reader returns, not merely a name the
	// scanner is willing to unlink.
	it("restores a dot-anchored backup whose random token came out empty", async () => {
		const leftover = path.join(dir, ".a.json.bak_1730000000000_.tmp")
		await fs.unlink(target)
		await fs.writeFile(leftover, JSON.stringify({ committed: true }))
		expect(JSON.parse(await readFileWithMissingRetry(target))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// And the name the writer produces out of that same answer: safeWriteJson guarantees a token, so the
	// staged name carries the empty token's stand-in, and the staged prefix - where the token is the only
	// thing that attributes the name - still recognises it.
	it("collects a staged leftover whose token is the empty-token stand-in", async () => {
		const leftover = path.join(dir, ".new_a.json_1730000000000_0.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not collect a staged-looking name that lacks the token", async () => {
		const unscoped = path.join(dir, ".new_a.json_1.tmp")
		await fs.writeFile(unscoped, "someone else's staging file")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		expect(await fs.readFile(unscoped, "utf8")).toBe("someone else's staging file")
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})

	// A shared directory is the failure mode the target-derived prefix exists to
	// prevent: a live writer of b.json holds only b.json's lock, so recovery of a.json
	// must not unlink the staging file that writer is about to rename onto b.json.
	it("leaves a sibling target's staging file alone when two targets share one directory", async () => {
		const sibling = path.join(dir, "b.json")
		await fs.writeFile(sibling, JSON.stringify({ sibling: true }))
		const mine = path.join(dir, ".new_a.json_1_mine.tmp")
		const theirs = path.join(dir, ".new_b.json_2_theirs.tmp")
		await fs.writeFile(mine, "stale")
		await fs.writeFile(theirs, "in flight")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		await expect(fs.access(mine)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(theirs, "utf8")).toBe("in flight")
		expect(JSON.parse(await fs.readFile(sibling, "utf8"))).toEqual({ sibling: true })
	})

	// The boundary a prefix check alone misses: a sibling whose basename *starts with* this
	// basename plus an underscore. Its staging name carries this file's prefix, and its writer
	// holds only its own lock, so collecting that name would unlink a live writer's staging file
	// and fail its commit rename with ENOENT.
	it("leaves the staging file of a sibling whose name extends this basename", async () => {
		const sibling = path.join(dir, "a.json_extra.json")
		await fs.writeFile(sibling, JSON.stringify({ sibling: true }))
		const mine = path.join(dir, ".new_a.json_1_mine.tmp")
		const theirs = path.join(dir, ".new_a.json_extra_2_theirs.tmp")
		await fs.writeFile(mine, "stale")
		await fs.writeFile(theirs, "in flight")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		await expect(fs.access(mine)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(theirs, "utf8")).toBe("in flight")
		expect(await fs.readFile(sibling, "utf8")).toBe(JSON.stringify({ sibling: true }))
	})

	// The negative boundary: safeWriteText accepts any basename matching .new_*.tmp, so
	// an unscoped name proves nothing about which target staged it, and recovery must
	// not treat it as this target's leftover.
	it("does not collect a bare .new_ staging file that is not scoped to this target", async () => {
		const unscoped = path.join(dir, ".new_unscoped.tmp")
		await fs.writeFile(unscoped, "someone else's staging file")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		expect(await fs.readFile(unscoped, "utf8")).toBe("someone else's staging file")
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})
})
