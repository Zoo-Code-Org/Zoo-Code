import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { PostCommitDurabilityError, safeWriteText } from "../safeWriteText"
import type { SafeWriteTextOptions } from "../safeWriteText"

const IS_WINDOWS = process.platform === "win32"

// Plays icacls for a test: records the flag it was asked for and, on its first call, moves *file*
// aside and leaves a different live file at that pathname. Renamed rather than unlinked, so the
// authorized inode stays allocated and cannot be handed back to the swap (the reuse that made the
// unlink-and-rewrite fixture above agree with itself on one runner and disagree on the other). The
// tail callback is read off the argument list because execFileRunner is typed as child_process
// .execFile, whose signatures take 2, 3 or 4 arguments.
// The return type needs an assertion, not a plain annotation: execFileRunner is typed as
// child_process.execFile, whose type carries a __promisify__ property that no plain function
// literal has, so the seam is built as a function and asserted into that shape.
function icaclsSeam(onDump?: [string, string], calls?: string[]): SafeWriteTextOptions["execFileRunner"] {
	let callsMade = 0
	const seam = (...args: unknown[]): void => {
		const tail = args[args.length - 1]
		const finish = (error?: Error | null): void => {
			if (typeof tail === "function") (tail as (e?: Error | null) => void)(error)
		}
		const argv = args[1]
		calls?.push(Array.isArray(argv) ? String(argv[1] ?? "") : "")
		if (onDump && callsMade++ === 0) {
			const [swapFrom, swapAside] = onDump
			void (async (): Promise<void> => {
				try {
					await fs.promises.rename(swapFrom, swapAside)
					await fs.promises.writeFile(swapFrom, "someone else's")
				} catch (swapFailure) {
					// A swap that cannot happen has to reach the row. Leaving finish uncalled here made the
					// row sit out the test timeout and report a hang, which is the failure this file exists
					// to make visible, so the error is handed to the callback instead.
					finish(swapFailure instanceof Error ? swapFailure : new Error(String(swapFailure)))
					return
				}
				finish()
			})()
			return
		}
		finish()
	}
	return seam as unknown as SafeWriteTextOptions["execFileRunner"]
}

// `rename` has no conditional form: there is no way to ask it to fire only if the file under the
// destination pathname is still the file an authorization was made about. The guard below is
// therefore a comparison, made as late as it can be made, between the identity the caller handed
// in and the identity of the path about to be written - and it refuses rather than publishing
// when they disagree or when the identity cannot be read at all. These rows run against the real
// filesystem, with no stubbing of fs.stat, because the assertion that matters is about what the
// path actually is at the moment of the commit. The identities below are read with
// { bigint: true } because the guard compares bigints: a plain stat hands back a 64-bit NTFS file
// id rounded to a double, so the guard would be comparing rounded numbers, and above 2**53 two
// different files can round to the same one. This volume's measured ids are all below 2**53 (see
// the option's comment), so these rows exercise the comparison and not the rounding.
describe("safeWriteText authorized identity", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "safe-write-identity-"))
	})
	afterEach(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true })
	})

	it("publishes when the target is still the file the caller authorized", async () => {
		const file = path.join(dir, "target.txt")
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file, { bigint: true })
		await safeWriteText(file, "after", { authorizedTarget: { dev: authorized.dev, ino: authorized.ino } })
		expect(await fs.promises.readFile(file, "utf8")).toBe("after")
	})

	// Two live files on one filesystem have different inodes unless they are hard links of each
	// other, so the guard is asked about an identity that provably is not the target's. The first
	// draft of this row unlinked the target and wrote a different file to the same pathname, which
	// passed on Windows and failed on the ubuntu runner: the freshly freed inode came back, so the
	// swapped-in file answered with the authorized identity and the guard correctly accepted it.
	// A test that asserts what a filesystem does with an inode it just released is not a test of
	// this guard.
	it("refuses to publish when the target is not the file whose identity was authorized", async () => {
		const file = path.join(dir, "target.txt")
		const other = path.join(dir, "other.txt")
		await fs.promises.writeFile(file, "before")
		await fs.promises.writeFile(other, "someone else's")
		const otherIdentity = await fs.promises.stat(other, { bigint: true })
		await expect(
			safeWriteText(file, "after", { authorizedTarget: { dev: otherIdentity.dev, ino: otherIdentity.ino } }),
		).rejects.toThrow(/changed identity after it was authorized/)
		expect(await fs.promises.readFile(file, "utf8")).toBe("before")
		expect(await fs.promises.readFile(other, "utf8")).toBe("someone else's")
	})

	// The row the review asked for, in the shape its own suggestion named: the file under the pathname
	// changes *during* the call rather than before it, through the seam the win32 step uses. platform
	// is overridden to "win32" so the DACL step runs on either runner, and the runner swaps the target
	// when icacls is asked to dump its DACL - after the temp is staged, before the commit-time identity
	// check. A check made on entry had already chosen this pathname and would publish over the stranger.
	it("refuses when a second live file takes the pathname while the write is in progress", async () => {
		const file = path.join(dir, "target.txt")
		const aside = path.join(dir, "authorized.txt")
		const calls: string[] = []
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file, { bigint: true })
		await expect(
			safeWriteText(file, "after", {
				authorizedTarget: { dev: authorized.dev, ino: authorized.ino },
				platform: "win32",
				execFileRunner: icaclsSeam([file, aside], calls),
			}),
		).rejects.toThrow(/changed identity after it was authorized/)
		expect(calls).toEqual(["/save"]) // the win32 step ran, from the override alone
		expect(await fs.promises.readFile(file, "utf8")).toBe("someone else's")
		expect(await fs.promises.readFile(aside, "utf8")).toBe("before")
	})

	// The other side of the same gate: with the override reading linux, no runner reaches icacls. The
	// commit rename is asserted through the durability error the linux arm can raise on a Windows host,
	// because fsync on a read-only handle is EPERM on win32 - the same reason the backup fsync below
	// opens its handle "r+" - so on win32 hosts this row sees PostCommitDurabilityError with the
	// content already at the target, and on a POSIX host it sees no error at all, which the next row
	// asserts where the runner can.
	it(`leaves the icacls seam untouched when the platform override says linux`, async () => {
		const file = path.join(dir, "target.txt")
		const calls: string[] = []
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file, { bigint: true })
		let failure: unknown = null
		try {
			await safeWriteText(file, "after", {
				authorizedTarget: { dev: authorized.dev, ino: authorized.ino },
				platform: "linux",
				execFileRunner: icaclsSeam(undefined, calls),
			})
		} catch (error: unknown) {
			failure = error
		}
		expect(calls).toEqual([])
		expect(await fs.promises.readFile(file, "utf8")).toBe("after")
		if (failure !== null) expect(failure).toBeInstanceOf(PostCommitDurabilityError)
	})

	// The linux arm's own row, and the one this box cannot prove: a runner whose real platform is
	// linux publishes through the same seam-free path with no error at all. It is skipped, not deleted,
	// on Windows - the measured reason is the EPERM above - so the ubuntu CI arm is the instrument that
	// proves the clean publish, and its negative control is this same file with the override omitted,
	// where process.platform is the platform being tested rather than a value handed to the writer.
	it.runIf(!IS_WINDOWS)(`publishes with no durability complaint when the platform override says linux`, async () => {
		const file = path.join(dir, "target.txt")
		const calls: string[] = []
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file, { bigint: true })
		await safeWriteText(file, "after", {
			authorizedTarget: { dev: authorized.dev, ino: authorized.ino },
			platform: "linux",
			execFileRunner: icaclsSeam(undefined, calls),
		})
		expect(calls).toEqual([])
		expect(await fs.promises.readFile(file, "utf8")).toBe("after")
	})
	// Failing closed: an unreadable identity is not the authorized file either, so the write refuses
	// instead of letting a raw stat failure escape as something else.
	it("refuses rather than reporting a raw stat failure when the authorized file is gone", async () => {
		const file = path.join(dir, "target.txt")
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file, { bigint: true })
		await fs.promises.unlink(file)
		await expect(
			safeWriteText(file, "after", { authorizedTarget: { dev: authorized.dev, ino: authorized.ino } }),
		).rejects.toThrow(/changed identity after it was authorized/)
		await expect(fs.promises.access(file)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
