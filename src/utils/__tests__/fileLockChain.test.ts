import * as fsp from "fs/promises"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import { acquireFileLock } from "../fileLock"

// Only the two filesystem calls this module makes are doubled, and the lock itself: an
// unexpected fs.stat call would fail the row instead of quietly resolving, which matters
// because the directory question is the one the task-persistence suites forbid asking.
vi.mock("fs/promises", () => ({ mkdir: vi.fn(), rmdir: vi.fn() }))
vi.mock("proper-lockfile", () => ({ lock: vi.fn() }))

// The doubles hold Node's recursive-mkdir contract, measured on this host rather than
// inferred from the docs: the call resolves with the first directory it actually created -
// on Windows reported with an extended-length \\?\ prefix - and with nothing when every
// level already existed. That answer is the only thing this module uses to decide what a
// failed acquisition may give back, so these rows keep the answer fixed and read the calls
// the module made, instead of asking a real filesystem to lose a race on schedule.
describe("what a failed lock acquisition gives back", () => {
	const lockRefused = (): Error =>
		Object.assign(new Error("EEXIST: file already exists, lock held"), { code: "EEXIST" })

	beforeEach(() => vi.clearAllMocks())

	it("claims nothing when every level of the chain already existed", async () => {
		const refusal = lockRefused()
		vi.mocked(fsp.mkdir).mockResolvedValue(undefined)
		vi.mocked(lockfile.lock).mockRejectedValue(refusal)
		await expect(acquireFileLock(path.join("C:", "tree", "state.json"))).rejects.toBe(refusal)
		// Nothing was created, so nothing may be removed: the directories here belong to
		// whoever put them there, and one of them may be somebody else's working tree.
		expect(fsp.rmdir).not.toHaveBeenCalled()
	})

	it("gives back only the levels the create reported, deepest first", async () => {
		const refusal = lockRefused()
		const firstLevel = path.join("C:", "tree", "one")
		// Node's answer on Windows arrives prefixed; the module normalises it before comparing.
		vi.mocked(fsp.mkdir).mockResolvedValue("\\\\?\\" + firstLevel)
		vi.mocked(lockfile.lock).mockRejectedValue(refusal)
		const target = path.join(firstLevel, "two", "state.json")
		await expect(acquireFileLock(target)).rejects.toBe(refusal)
		expect(vi.mocked(fsp.mkdir).mock.calls.map((call) => String(call[0]))).toEqual([path.join(firstLevel, "two")])
		expect(vi.mocked(fsp.rmdir).mock.calls.map((call) => String(call[0]))).toEqual([
			path.join(firstLevel, "two"),
			firstLevel,
		])
	})
})
