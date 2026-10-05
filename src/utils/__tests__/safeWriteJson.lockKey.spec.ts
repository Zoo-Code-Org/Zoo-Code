// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import * as os from "os"
import path from "path"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"

vi.mock("../fileLock", () => ({
	acquireFileLock: vi.fn(async () => async () => {}),
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return {
		...actual,
		realpath: vi.fn(),
		lstat: vi.fn(),
		readlink: vi.fn(),
	}
})

const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedAcquireFileLock = vi.mocked(acquireFileLock)

beforeEach(() => {
	vi.mocked(acquireFileLock).mockImplementation(async () => async () => {})
	mockedRealpath.mockImplementation((p) => actualRealpath(p as string))
	mockedLstat.mockImplementation((p) => actualLstat(p as string))
	mockedReadlink.mockImplementation(async (p) => (p === link ? referent : Promise.reject(new Error("not a link"))))
})

const actualRealpath = (p: string) => fs.realpath(p)
const actualLstat = (p: string) => fs.lstat(p)
const actualReadlink = (p: string) => fs.readlink(p)

describe("safeWriteJson lock key under a peer commit", () => {
	it("waits for the peer instead of rejecting, and locks the referent", async () => {
		const order: string[] = []
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lockkey-"))
		const referent = path.join(dir, "history_item.json")
		const link = path.join(dir, "link.json")

		// A dangling link: the peer writer has renamed the referent away and has
		// not committed yet, so the first resolution throws ENOENT while lstat
		// still reports a symbolic link. A strict resolve here rejects the caller
		// before it can ever take the lock, so the delta write is lost.
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		mockedRealpath
			.mockImplementationOnce(() => {
				order.push("resolve-failed")
				throw enoent
			})
			.mockImplementation(async (p) => {
				order.push("resolve")
				return p === link ? referent : (p as string)
			})
		mockedLstat.mockImplementation(async (p) => ({
			isSymbolicLink: () => p === link,
		}))
		mockedReadlink.mockImplementation(async (p) => (p === link ? referent : actualReadlink(p as string)))
		mockedAcquireFileLock.mockImplementation(async (lockPath) => {
			order.push("lock")
			expect(lockPath).toBe(referent)
			return async () => {}
		})

		await safeWriteJson(link, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the
		// caller queued behind the peer instead of failing before the lock.
		expect(order).toEqual(["resolve-failed", "lock", "resolve", "resolve"])
		const committed = JSON.parse(await fs.readFile(referent, "utf8"))
		expect(committed).toEqual({ id: "task-1" })
	})
})
