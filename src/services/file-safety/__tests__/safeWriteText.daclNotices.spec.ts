import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"

// The win32 DACL steps are reachable on any runner through the platform override, but two of their
// inputs are not reproducible on one portable filesystem: a target that exists while its access
// rights cannot be read, and a saved DACL dump whose unlink keeps failing. Both sit behind fs calls,
// so this file mocks fs/promises and fs the way safeWriteText.spec.ts does and drives them per case.
vi.mock("fs/promises", () => ({
	copyFile: vi.fn(),
	chmod: vi.fn(),
	mkdir: vi.fn(),
	access: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	rmdir: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
	readlink: vi.fn(),
}))

vi.mock("fs", () => ({
	openSync: vi.fn(),
	writeSync: vi.fn(),
	closeSync: vi.fn(),
	mkdirSync: vi.fn(),
	fsyncSync: vi.fn(),
	chmodSync: vi.fn(),
	fchmodSync: vi.fn(),
	statSync: vi.fn(),
	Stats: class Stats {},
}))

import { safeWriteText, StagingPathError, type SafeWriteTextOptions } from "../safeWriteText"

const TARGET = path.join(path.resolve("/safeWriteText-notice"), "notice.txt")
const DIR = path.dirname(TARGET)
const CALLER_STAGED = path.join(DIR, "caller-staged.tmp")

function codeError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code })
}

function statsWithMode(mode: number): fsSync.Stats {
	const stats = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(stats, { mode })
	return stats
}

// The publish path reads only isFile/isSymbolicLink and the ino/dev pair out of a lstat result. The
// identity pair is typed number|bigint here so one case can hand back a non-bigint ino, which
// fs.lstat(path, { bigint: true }) never produces on a real filesystem.
function fileStatsWithIdentity(ino: number | bigint, dev: number | bigint): fsSync.Stats {
	const stats = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(stats, { ino, dev, isSymbolicLink: () => false, isFile: () => true })
	return stats
}

interface IcaclsDouble {
	calls: string[][]
	runner: NonNullable<SafeWriteTextOptions["execFileRunner"]>
}

// The SUT calls execFile in its (file, args, options, callback) form. The double assertion is needed
// because the real callback also reports stdout and stderr, which this double has nothing of.
function icaclsDouble(outcome: { save?: Error; restore?: Error }): IcaclsDouble {
	const calls: string[][] = []
	const runner = ((_cmd: string, args: readonly string[], _options: unknown, callback: (error: unknown) => void) => {
		calls.push(Array.from(args))
		if (args[1] === "/save") {
			callback(outcome.save ?? null)
		} else {
			callback(outcome.restore ?? null)
		}
		return { kill: () => true }
	}) as unknown as NonNullable<SafeWriteTextOptions["execFileRunner"]>
	return { calls, runner }
}

/** Run one publish against the mocks and collect every notice it delivers. */
async function publish(options: SafeWriteTextOptions): Promise<{ leftoverPaths: string[]; warnings: string[] }> {
	const warnings: string[] = []
	const result = await safeWriteText(TARGET, "x", {
		platform: "win32",
		...options,
		onWarning: (message: string) => {
			warnings.push(message)
		},
	})
	return { leftoverPaths: result.leftoverPaths, warnings }
}

/** Paths this publish tried to unlink, in call order. */
function unlinkCalls(): string[] {
	return vi.mocked(fs.unlink).mock.calls.map((call) => String(call[0]))
}

describe("safeWriteText win32 DACL notices", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		vi.mocked(fs.rmdir).mockResolvedValue(undefined)
		vi.mocked(fs.realpath).mockResolvedValue(TARGET)
		vi.mocked(fs.lstat).mockResolvedValue(fileStatsWithIdentity(1n, 1n))
		vi.mocked(fsSync.statSync).mockReturnValue(statsWithMode(0o644))
		vi.mocked(fsSync.openSync).mockReturnValue(7)
		vi.mocked(fsSync.writeSync).mockImplementation(() => 1)
	})

	it("names the target, the icacls error and the consequence when the DACL save fails", async () => {
		const { runner } = icaclsDouble({ save: codeError("EPERM", "icacls save failed") })

		const { leftoverPaths, warnings } = await publish({ execFileRunner: runner })

		// The code is printed, not swallowed: errorCode(saveDaclError) ?? "no error code" must print
		// the code when there is one, and the notice has to say what the publish risks by continuing.
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toBe(
			`safeWriteText: could not save the DACL of ${TARGET} (EPERM); ` +
				`publishing without it means the file at the target may answer to different access rights.`,
		)
		expect(leftoverPaths).toEqual([])
	})

	it("names the dump path and the unlink error when the partial dump cannot be removed", async () => {
		const { calls, runner } = icaclsDouble({ save: codeError("EPERM", "icacls save failed") })
		vi.mocked(fs.unlink).mockImplementation(async (residuePath) => {
			if (String(residuePath).includes(".safeWriteText.acl_")) {
				throw codeError("EPERM", "dump still open")
			}
		})

		const { leftoverPaths, warnings } = await publish({ execFileRunner: runner })

		const dumpPath = String(calls[0]?.[2])
		expect(warnings).toHaveLength(2)
		expect(warnings[1]).toBe(`safeWriteText: the partial DACL dump could not be removed from ${dumpPath} (EPERM).`)
		expect(leftoverPaths).toContain(dumpPath)
	})

	it("names the target, the access error and the consequence when access rights cannot be read", async () => {
		vi.mocked(fs.access).mockImplementation(async (target) => {
			if (String(target) === TARGET) {
				throw codeError("EACCES", "access rights unreadable")
			}
		})

		const { leftoverPaths, warnings } = await publish({ execFileRunner: icaclsDouble({}).runner })

		// An existing target whose rights cannot be read is not an absent target: the publish continues
		// and the notice names the code, so it must not be confused with the ENOENT case below.
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toBe(
			`safeWriteText: could not read the access rights of ${TARGET} (EACCES); ` +
				`publishing without them means the file at the target may answer to different access rights.`,
		)
		expect(leftoverPaths).toEqual([])
	})

	it("publishes an absent target with no notice and no DACL save", async () => {
		const { calls, runner } = icaclsDouble({})
		vi.mocked(fs.access).mockImplementation(async (target) => {
			if (String(target) === TARGET) {
				throw codeError("ENOENT", "no such file")
			}
		})

		const { leftoverPaths, warnings } = await publish({ execFileRunner: runner })

		// "could not read the access rights" is the notice for a target that is there; an absent target
		// is the ordinary first write and must produce no notice at all, and no icacls run.
		expect(warnings).toEqual([])
		expect(calls).toEqual([])
		expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1)
		expect(String(vi.mocked(fs.rename).mock.calls[0]?.[1])).toBe(TARGET)
		expect(leftoverPaths).toEqual([])
	})

	it("names the kept dump and the restore error when the restore fails after the commit", async () => {
		const { calls, runner } = icaclsDouble({ restore: codeError("EPERM", "icacls restore failed") })

		const { leftoverPaths, warnings } = await publish({ execFileRunner: runner })

		const dumpPath = String(calls[0]?.[2])
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toBe(
			`safeWriteText: committed ${TARGET} but could not restore its saved access rights ` +
				`(EPERM); the DACL dump is kept at ${dumpPath} ` +
				`so it can be restored manually.`,
		)
		// The dump is the operator's only way to put the rights back, so it is kept and reported.
		expect(leftoverPaths).toContain(dumpPath)
		expect(unlinkCalls().some((candidate) => candidate === dumpPath)).toBe(false)
	})

	it("accepts a caller-staged file whose lstat reports a non-bigint inode", async () => {
		vi.mocked(fs.lstat).mockImplementation(async (stagedPath) => {
			const identity = String(stagedPath) === CALLER_STAGED ? 7 : 7
			return fileStatsWithIdentity(identity, 3)
		})

		const { leftoverPaths } = await publish({ tempPath: CALLER_STAGED })

		// A non-bigint ino pair is not an identity match: fs.lstat(path, { bigint: true }) answers
		// bigint, so treating a number pair as proof of the same file would refuse a staging file that
		// merely carries a number-shaped inode.
		expect(vi.mocked(fs.rename).mock.calls[0]?.[0]).toBe(CALLER_STAGED)
		expect(leftoverPaths).toEqual([])
	})

	it("refuses a caller-staged file that is the target itself", async () => {
		vi.mocked(fs.lstat).mockResolvedValue(fileStatsWithIdentity(7n, 3n))

		await expect(publish({ tempPath: TARGET })).rejects.toBeInstanceOf(StagingPathError)

		expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
	})

	// The refusal at the target lstat only says the identity comparison could not be made; the
	// caught error is the only thing that says why. It has to arrive as the cause, or a support
	// report can repeat the sentence without learning whether the target was locked or unreadable.
	it("carries the target lstat error as the cause of the staging-path refusal", async () => {
		const unreadable = codeError("EACCES", "target identity unreadable")
		vi.mocked(fs.lstat).mockImplementation(async (stagedPath) => {
			if (String(stagedPath) === CALLER_STAGED) {
				return fileStatsWithIdentity(7n, 3n)
			}
			throw unreadable
		})

		const failure = await publish({
			tempPath: CALLER_STAGED,
			execFileRunner: icaclsDouble({}).runner,
		}).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(StagingPathError)
		// instanceof narrows instead of casting, and the assertion above already fails when the
		// publish refused with anything else.
		if (failure instanceof StagingPathError) {
			expect(failure.cause).toBe(unreadable)
		}
	})

	it("removes the backup copy after a successful publish", async () => {
		const { leftoverPaths, warnings } = await publish({ backup: true, execFileRunner: icaclsDouble({}).runner })

		expect(warnings).toEqual([])
		expect(unlinkCalls().some((candidate) => candidate.includes(".safeWriteText.bak_"))).toBe(true)
		expect(leftoverPaths).toEqual([])
	})

	it("has no backup copy to remove when the target was absent", async () => {
		vi.mocked(fs.access).mockImplementation(async (target) => {
			if (String(target) === TARGET) {
				throw codeError("ENOENT", "no such file")
			}
		})

		const { leftoverPaths, warnings } = await publish({ backup: true, execFileRunner: icaclsDouble({}).runner })

		expect(warnings).toEqual([])
		expect(unlinkCalls().some((candidate) => candidate.includes(".safeWriteText.bak_"))).toBe(false)
		expect(leftoverPaths).toEqual([])
	})

	it("removes the backup copy when the commit rename fails after the backup was copied", async () => {
		vi.mocked(fs.rename).mockRejectedValue(codeError("EPERM", "rename blocked"))

		await expect(publish({ backup: true, execFileRunner: icaclsDouble({}).runner })).rejects.toThrow(
			"rename blocked",
		)

		// The copy has served its purpose either way, so a failed commit must not leave it beside the
		// target where no caller would find it.
		expect(unlinkCalls().some((candidate) => candidate.includes(".safeWriteText.bak_"))).toBe(true)
	})
})
