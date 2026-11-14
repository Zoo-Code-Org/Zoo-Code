// npx vitest run utils/__tests__/safeWriteJson.postCommitDurability.spec.ts

import * as fsSync from "fs"
import type { WriteStream as FsWriteStream } from "fs"
import * as os from "os"
import path from "path"

import * as fs from "fs/promises"

import { safeWriteJson } from "../safeWriteJson"

// Real filesystem throughout: what this spec has to prove is what the target's directory
// actually holds after a durability failure, and a fully mocked fs cannot show that.
// Only the sync primitives this module reaches for are wrapped - openSync for the
// post-commit directory fsync and createWriteStream for the staged write - and each
// wrapper delegates to the real implementation for every path except the one a test
// deliberately fails. The real implementations are captured inside the mock factory,
// before any vi.fn() wrapper exists, so a test's implementation callback can delegate
// without recursing into itself.
type OpenSyncRest = (...args: unknown[]) => number
type WriteStreamRest = (filePath: string, options: { encoding: string }) => FsWriteStream
const actuals = vi.hoisted(
	(): {
		openSync: OpenSyncRest | null
		writeStream: WriteStreamRest | null
	} => ({ openSync: null, writeStream: null }),
)

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	// Node declares both functions as sets of overloads; capturing each as a rest-args or
	// narrowed function is what lets this spec forward the arguments unchanged instead of
	// re-declaring them.
	actuals.openSync = actual.openSync as OpenSyncRest
	actuals.writeStream = actual.createWriteStream as unknown as WriteStreamRest
	return {
		...actual,
		openSync: vi.fn(actual.openSync),
		createWriteStream: vi.fn(actual.createWriteStream as unknown as WriteStreamRest),
	}
})

// The advisory lock is not under test here; the real proper-lockfile would add a lock
// directory to the very directory this spec inspects for residue.
vi.mock("../fileLock", () => ({
	acquireFileLock: vi.fn(async () => async () => {}),
}))

describe("safeWriteJson post-commit durability", () => {
	let dir: string
	// safeWriteJson derives the directory it fsyncs from the RESOLVED target, so the
	// injected failure has to be keyed to the same spelling realpath reports.
	let dirKey: string
	let targetPath: string
	let originalPlatform: NodeJS.Platform

	beforeEach(async () => {
		originalPlatform = process.platform
		// The parent-directory fsync (_flushDirectoryToDisk) is POSIX-only: Windows cannot
		// open a directory for this purpose, so the branch is only reachable when the
		// process reports a POSIX platform.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })

		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-json-postcommit-"))
		dirKey = await fs.realpath(dir)
		targetPath = path.join(dirKey, "history_item.json")
		await fs.writeFile(targetPath, JSON.stringify({ version: "old" }))
	})

	afterEach(async () => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
		vi.restoreAllMocks()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("releases every staging artifact when the post-commit directory fsync fails, and reports the write as committed", async () => {
		// The commit rename already published the new JSON; only the durability of the
		// directory entry that records the rename is in doubt. This module owns that fsync,
		// and it swallows the failure rather than reporting a completed write as a failed
		// one: the content is at the target either way, so a rejection would leave in-memory
		// state diverging from disk. The staging file (and the backup copy, when the write
		// took one) is still removed - leaving them behind would mean every affected write
		// leaks another hidden copy next to the target.
		let dirOpenAttempted = false
		const openSyncActual = actuals.openSync
		if (openSyncActual === null) {
			throw new Error("fs mock did not capture the real openSync")
		}
		vi.mocked(fsSync.openSync).mockImplementation((...args: Parameters<typeof fsSync.openSync>) => {
			if (String(args[0]) === dirKey) {
				// Pin the injection: without this flag the test would also pass on a run where
				// the directory sync never fired at all, which proves nothing about the path
				// that the failure handler takes.
				dirOpenAttempted = true
				throw Object.assign(new Error("EINVAL: invalid argument, open '" + dirKey + "'"), { code: "EINVAL" })
			}
			return openSyncActual(...args)
		})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await safeWriteJson(targetPath, { version: "new" })

		expect(dirOpenAttempted).toBe(true)
		expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({ version: "new" })
		// The swallowed error is still reported to the log: the directory entry is not known
		// to be durable, and a caller that cannot see that would over-claim the write.
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(errorSpy).not.toHaveBeenCalled()
		// No backup copy, no staging temp, no staging directory: only the published file.
		expect(await fs.readdir(dir)).toEqual(["history_item.json"])
	})

	it("still rejects a failure before the commit rename, and leaves no residue", async () => {
		// The post-commit leniency must stay narrow: a failure that happens before the commit
		// has not published anything, and swallowing it would report a write that never ran.
		// This module writes the staged file through a stream, so the pre-commit failure is
		// injected on that stream.
		let tempWriteAttempted = false
		const writeStreamActual = actuals.writeStream
		if (writeStreamActual === null) {
			throw new Error("fs mock did not capture the real createWriteStream")
		}
		vi.mocked(fsSync.createWriteStream).mockImplementation(
			(...args: Parameters<typeof fsSync.createWriteStream>) => {
				const stagedPath = String(args[0])
				if (stagedPath.includes(".new_")) {
					// Pin the injection: without this flag the test would also pass on a run where
					// the write never reached a staged file at all.
					tempWriteAttempted = true
					const stream = writeStreamActual(stagedPath, { encoding: "utf8" })
					process.nextTick(() => {
						stream.emit("error", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
					})
					return stream
				}
				return writeStreamActual(stagedPath, { encoding: "utf8" })
			},
		)

		await expect(safeWriteJson(targetPath, { version: "new" })).rejects.toThrow("EACCES: permission denied")

		expect(tempWriteAttempted).toBe(true)
		// Nothing was published: the target still holds the previous content, and the staged
		// file this write created is gone again - the failure handler removed it.
		expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({ version: "old" })
		expect(await fs.readdir(dir)).toEqual(["history_item.json"])
	})
})
