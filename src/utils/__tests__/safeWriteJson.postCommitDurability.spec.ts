// npx vitest run utils/__tests__/safeWriteJson.postCommitDurability.spec.ts

import * as fsSync from "fs"
import * as os from "os"
import path from "path"

import * as fs from "fs/promises"

import { safeWriteJson } from "../safeWriteJson"

// Real filesystem throughout: what this spec has to prove is what the target's directory
// actually holds after a post-commit durability failure, and a fully mocked fs cannot show
// that. Only the sync openSync is wrapped, and it delegates to the real implementation for
// every path except the one a test deliberately fails. The real openSync is captured inside
// the mock factory, before any vi.fn() wrapper exists, so a test's implementation callback
// can delegate without recursing into itself.
type OpenSyncRest = (...args: unknown[]) => number
const actuals = vi.hoisted((): { openSync: OpenSyncRest | null } => ({ openSync: null }))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	// Node declares openSync as a set of overloads; capturing it as a rest-args function is
	// what lets this spec forward every argument tuple unchanged instead of re-declaring them.
	actuals.openSync = actual.openSync as OpenSyncRest
	return { ...actual, openSync: vi.fn(actual.openSync) }
})

// The advisory lock is not under test here; the real proper-lockfile would add a lock
// directory to the very directory this spec inspects for residue.
vi.mock("../fileLock", () => ({
	acquireFileLock: vi.fn(async () => async () => {}),
}))

describe("safeWriteJson post-commit durability (backup: true)", () => {
	let dir: string
	// safeWriteText derives its directory path from the RESOLVED target, so the injected
	// failure has to be keyed to the same spelling realpath reports.
	let dirKey: string
	let targetPath: string
	let originalPlatform: NodeJS.Platform

	beforeEach(async () => {
		originalPlatform = process.platform
		// safeWriteJson always passes backup:true and never overrides the platform, so the
		// POSIX parent-directory fsync (safeWriteText step 4b) is only reachable when the
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

	it("releases the backup a failed post-commit directory fsync retained, and reports the write as committed", async () => {
		// The commit rename already published the new JSON; only the durability of the
		// directory entry is in doubt. safeWriteText keeps the previous-content copy on this
		// path and hands its location to the caller through PostCommitDurabilityError, so
		// safeWriteJson - the only caller that ever turns backup on through this path - owns
		// that copy. Leaving it behind means every affected write leaks one more hidden full
		// copy of the old content next to the target.
		let dirOpenAttempted = false
		const openSyncActual = actuals.openSync
		if (openSyncActual === null) {
			throw new Error("fs mock did not capture the real openSync")
		}
		vi.mocked(fsSync.openSync).mockImplementation((...args: Parameters<typeof fsSync.openSync>) => {
			if (String(args[0]) === dirKey) {
				// Pin the injection: without this flag the test would also pass on a run where
				// the failure never fired, which proves nothing about the retained backup.
				dirOpenAttempted = true
				throw Object.assign(new Error("EINVAL: invalid argument, open '" + dirKey + "'"), { code: "EINVAL" })
			}
			return openSyncActual(...args)
		})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// The caller's result: the content is at the target, so the write is reported as done
		// rather than as a failure that leaves in-memory state diverging from disk.
		await safeWriteJson(targetPath, { version: "new" })

		expect(dirOpenAttempted).toBe(true)
		expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({ version: "new" })
		// The swallowed error is still reported to the log: the directory entry is not known
		// to be durable, and a caller that cannot see that would over-claim the write.
		expect(warnSpy).toHaveBeenCalledTimes(1)
		// No backup copy, no staging temp, no staging directory: only the published file.
		expect(await fs.readdir(dir)).toEqual(["history_item.json"])
	})

	it("still rejects a failure before the commit rename, and leaves no backup residue", async () => {
		// The post-commit handling must stay narrow: a failure that happens before the commit
		// has not published anything, and swallowing it would report a write that never ran.
		let tempOpenAttempted = false
		const openSyncActual = actuals.openSync
		if (openSyncActual === null) {
			throw new Error("fs mock did not capture the real openSync")
		}
		vi.mocked(fsSync.openSync).mockImplementation((...args: Parameters<typeof fsSync.openSync>) => {
			// The staging file safeWriteJson wrote beside the target: safeWriteText opens it
			// with "r+" to apply the target's mode before the commit rename.
			if (String(args[0]).includes(".new_")) {
				tempOpenAttempted = true
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			}
			return openSyncActual(...args)
		})

		await expect(safeWriteJson(targetPath, { version: "new" })).rejects.toThrow("EACCES: permission denied")

		expect(tempOpenAttempted).toBe(true)
		// Nothing was published: the target still holds the previous content, and the backup
		// copy safeWriteText took before the commit was removed by its own failure handler.
		expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({ version: "old" })
		expect(await fs.readdir(dir)).toEqual(["history_item.json"])
	})
})
