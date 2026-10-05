// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import * as os from "os"
import path from "path"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"

vi.mock("../fileLock", () => ({
	acquireFileLock: vi.fn(async () => async () => {}),
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, realpath: vi.fn(), lstat: vi.fn(), readlink: vi.fn() }
})

const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedAcquireFileLock = vi.mocked(acquireFileLock)

const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })

// Only isSymbolicLink() is consulted by the guard, so the double carries just
// that method. The mocks reject asynchronously: a synchronous throw would bypass
// resolvePublishTarget's catch and skip the ENOENT/symlink branch under test.
const symlinkStat = (target: unknown) => ({ isSymbolicLink: () => target === currentLink }) as unknown as BigIntStats
let currentLink = ""

describe("safeWriteJson lock key under a peer commit", () => {
	it("waits for the peer instead of rejecting, and locks the referent", async () => {
		const order: string[] = []
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lockkey-"))
		const referent = path.join(dir, "history_item.json")
		currentLink = path.join(dir, "link.json")

		// The peer writer has renamed the referent away and has not committed yet,
		// so the first resolution fails with ENOENT while lstat still reports a
		// symbolic link. A strict resolve here rejects the caller before it can ever
		// queue behind the peer, and the caller's delta write is lost.
		mockedRealpath
			.mockImplementationOnce(async () => {
				order.push("resolve-failed")
				throw enoent
			})
			.mockImplementation(async (target) => {
				order.push("resolve")
				// The second call happens under the lock, where the peer has committed.
				return target === currentLink ? referent : String(target)
			})
		mockedLstat.mockImplementation(async (target) => {
			order.push("lstat")
			return symlinkStat(target)
		})
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		expect(order).toEqual(["resolve-failed", "lstat", "lock", "resolve", "resolve"])
		expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ id: "task-1" })
	})

	it("releases the lock when the resolution under the lock rejects", async () => {
		const order: string[] = []
		let released = false
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lockkey-"))
		const referent = path.join(dir, "history_item.json")
		currentLink = path.join(dir, "link.json")

		// A real dangling link: the walk tolerates it so the caller can queue behind
		// the peer, but once the lock is held the strict rejection still applies. A
		// rejection outside the protected block would leave the lock held until the
		// stale timeout for every other writer to the same file.
		mockedRealpath.mockImplementation(async () => {
			throw enoent
		})
		mockedLstat.mockImplementation(async (target) => {
			order.push("lstat")
			return symlinkStat(target)
		})
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {
				order.push("release")
				released = true
			}
		})

		await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toThrow(enoent)
		expect(released).toBe(true)
		// The strict rejection is reached through the ENOENT + symlink branch, not
		// through a synchronous throw that skips it.
		expect(order).toEqual(["lstat", "lock", "lstat", "release"])
	})
})
