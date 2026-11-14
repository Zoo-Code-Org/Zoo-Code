import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import { acquireFileLock, lockPathFor } from "../fileLock"

// These rows run against the real proper-lockfile on real temporary directories. The
// property is which artefact two writers reach, and a stubbed lock cannot answer it:
// a stub reports whatever shape the test hands it, including a shape production does
// not build.
describe("file lock contention where the directory has to be created first", () => {
	it("a writer that arrives after the directory exists contends with the writer that made it", async () => {
		const base = await fsp.mkdtemp(path.join(os.tmpdir(), "filelock-contend-"))
		const target = path.join(base, "missing", "nested", "state.json")
		try {
			const releaseFirst = await acquireFileLock(target)
			expect((await fsp.stat(path.dirname(target))).isDirectory()).toBe(true)
			// The second writer arrives while the first still holds and after the directory
			// appeared. Under ancestor-first locking it would have derived a different
			// artefact and walked straight in; the artefact is derived from the guarded path,
			// so it contends.
			// proper-lockfile reports a held artefact as its own error rather than the raw
			// mkdir collision, so the row names what the caller actually sees.
			await expect(acquireFileLock(target, { immediate: true })).rejects.toThrow(/already being held/)
			await releaseFirst()
			const releaseSecond = await acquireFileLock(target, { immediate: true })
			expect((await fsp.stat(lockPathFor(target))).isDirectory()).toBe(true)
			await releaseSecond()
			await expect(fsp.stat(lockPathFor(target))).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fsp.rm(base, { recursive: true, force: true })
		}
	})

	it("two writers racing into the same missing directory leave exactly one holding the path", async () => {
		const base = await fsp.mkdtemp(path.join(os.tmpdir(), "filelock-race-"))
		const target = path.join(base, "missing", "nested", "state.json")
		const attempts = await Promise.allSettled([
			acquireFileLock(target, { immediate: true }),
			acquireFileLock(target, { immediate: true }),
		])
		const holding = attempts.filter((attempt) => attempt.status === "fulfilled")
		const refused = attempts.filter((attempt) => attempt.status === "rejected")
		try {
			expect(holding).toHaveLength(1)
			expect(refused).toHaveLength(1)
			expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
			expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/already being held/)
			// One artefact, held by one writer: the refused attempt creates no lock of its own
			// and leaks nothing behind. The refused attempt has already run its rollback here, and one of
			// the two created the directory the artefact stands in: the directory and the live artefact
			// both have to outlive that rollback, and the holder has to be able to release. (Row
			// 4507646158 follow-up: this is the window the reviewer's rollback claim is about.)
			expect((await fsp.stat(path.dirname(target))).isDirectory()).toBe(true)
			expect((await fsp.stat(lockPathFor(target))).isDirectory()).toBe(true)
			await holding[0]!.value()
			await expect(fsp.stat(lockPathFor(target))).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fsp.rm(base, { recursive: true, force: true })
		}
	})
})
