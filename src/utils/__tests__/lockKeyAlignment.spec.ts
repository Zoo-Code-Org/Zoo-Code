// Pairing test for the ask in review comment 4545130063 on pull 1913, "Use the same lock key as
// `safeWriteJson`.", paid on pull 2433, whose src/utils/fileLock.ts blob 6ca70045661c is
// byte-identical to the blob 1913 carried before that fix. withFileLock (the door a task-history
// deletion comes through), safeWriteJson and the protocol inside acquireFileLock must all hold the
// canonical referent key for a symlink alias. On this head both callers already compute the
// canonical key for themselves - fileLock.ts:86 and safeWriteJson.ts:248 - so the first two rows
// below pass with or without the canonicalization inside acquireFileLock. The third row is the one
// that pins that line: take it out and that row fails, which is what makes this an answer to the
// ask rather than a mirror of the fix.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { BigIntStats } from "fs"
import * as lockfile from "proper-lockfile"
import { safeWriteJson } from "../safeWriteJson"
import { acquireFileLock, withFileLock } from "../fileLock"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
	unlock: vi.fn(async () => {}),
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, realpath: vi.fn(), lstat: vi.fn(), readlink: vi.fn() }
})

const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedLock = vi.mocked(lockfile.lock)

let dir = ""
let referent = ""
let alias = ""

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "lockkey-alignment-"))
	referent = path.join(dir, "task.json")
	alias = path.join(dir, "alias.json")
	await fs.writeFile(referent, "{}", "utf8")
})

afterAll(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
	mockedRealpath.mockReset()
	mockedLstat.mockReset()
	mockedReadlink.mockReset()
	mockedLock.mockReset()
	// alias.json is a symlink to task.json; every other path resolves to itself.
	mockedRealpath.mockImplementation(async (target) => (String(target) === alias ? referent : String(target)))
	// fs/promises types lstat as returning BigIntStats and this double only ever needs isSymbolicLink().
	// AGENTS.md asks for a reason beside a cast a typed API cannot express: no row in this file reads a
	// bigint field, so no bigint field is faked.
	mockedLstat.mockImplementation(async () => ({ isSymbolicLink: () => false }) as BigIntStats)
	mockedReadlink.mockRejectedValue(Object.assign(new Error("not a link"), { code: "EINVAL" }))
})

describe("lock-key alignment between withFileLock and safeWriteJson", () => {
	it("locks the canonical referent for an alias, whichever door the caller comes through", async () => {
		await withFileLock(alias, async () => undefined)
		const deletionKey = mockedLock.mock.calls[0][0]
		await safeWriteJson(alias, { pinned: 1 })
		const writeKeys = mockedLock.mock.calls.map((call) => call[0])
		const writeKey = writeKeys[writeKeys.length - 1]
		expect(deletionKey).toBe(referent)
		expect(writeKey).toBe(referent)
		expect(deletionKey).toBe(writeKey)
		expect(deletionKey).toBe(await resolveLockKey(alias))
	})

	it("keeps one key for a plain path and hands the operation its own path", async () => {
		let seenByOperation = ""
		await withFileLock(referent, async (absoluteFilePath) => {
			seenByOperation = absoluteFilePath
		})
		const plainKey = mockedLock.mock.calls[0][0]
		await safeWriteJson(referent, { pinned: 2 })
		const plainWriteKeys = mockedLock.mock.calls.map((call) => call[0])
		expect(plainKey).toBe(plainWriteKeys[plainWriteKeys.length - 1])
		expect(plainKey).toBe(await resolveLockKey(referent))
		expect(seenByOperation).toBe(referent)
	})

	it("locks the canonical referent when a caller comes through acquireFileLock itself", async () => {
		// The row that pins the canonicalization inside the shared protocol: a caller that hands the
		// protocol the alias directly must still get the referent, because no caller spelling is trusted
		// any more than the two above.
		await acquireFileLock(alias)
		expect(mockedLock.mock.calls.length).toBe(1)
		expect(mockedLock.mock.calls[0][0]).toBe(referent)
		expect(mockedLock.mock.calls[0][0]).toBe(await resolveLockKey(alias))
	})
})
