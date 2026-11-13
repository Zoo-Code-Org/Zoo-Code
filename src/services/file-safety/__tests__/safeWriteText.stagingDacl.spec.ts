import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"
import { execFile, spawnSync } from "child_process"
import type { ChildProcess, ExecFileException, ExecFileOptions } from "child_process"

import { safeWriteText } from "../safeWriteText"

// This file exists for one row, and that row is about NTFS access rights, so the row runs only where
// those rights are real: on any other platform the writer skips the DACL steps entirely and there is
// nothing here to measure. The capability is probed once, by asking icacls to narrow a throwaway
// directory the way the writer narrows its staging directory, so a host without icacls - or without
// the right to change an access list - skips this row instead of failing it.
function runIcacls(args: string[]): { code: number | string; out: string } {
	const result = spawnSync("icacls", args, { encoding: "utf8" })
	return {
		code: result.status ?? (result.error ? String(result.error) : "unknown"),
		out: (result.stdout ?? "").concat(result.stderr ?? "").replace(/\r/g, ""),
	}
}

// The accounts the review row is about: other users of the same machine. Privileged accounts -
// SYSTEM, Administrators - keep their rights on a narrowed directory too, and the row makes no claim
// about them; what a mode of 0700 is meant to withhold is read by BUILTIN\\Users and modify by
// NT AUTHORITY\\Authenticated Users, which is exactly what a staging directory inherits here.
const OTHER_USER_PRINCIPALS = ["BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users"]

function otherUserRightsIn(listing: string): string[] {
	const lowered = listing.toLowerCase()
	return OTHER_USER_PRINCIPALS.filter((principal: string) => lowered.includes(principal.toLowerCase()))
}

function accountName(): string {
	try {
		return os.userInfo().username
	} catch {
		return ""
	}
}

function accountForGrant(): string {
	const name = accountName()
	// The writer refuses to name a trustee it cannot trust either, for the same reason: a name
	// carrying a colon or a parenthesis is not an account name icacls can take.
	if (name === "" || /[:()]/.test(name)) {
		return ""
	}
	return name
}

function ntfsAclsUsable(): boolean {
	if (process.platform !== "win32") {
		return false
	}
	const account = accountForGrant()
	if (account === "") {
		return false
	}
	const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "fws-aclprobe-"))
	try {
		const file = path.join(probe, "probe.txt")
		fsSync.writeFileSync(file, "probe", "utf8")
		const grants = [
			runIcacls([probe, "/grant:r", "BUILTIN\\Users:(OI)(CI)(RX)"]),
			runIcacls([probe, "/grant:r", "NT AUTHORITY\\Authenticated Users:(OI)(CI)(M)"]),
		]
		const narrowed = runIcacls([file, "/inheritance:r", "/grant:r", account + ":(F)"])
		const dirListing = runIcacls([probe]).out
		const fileListing = runIcacls([file]).out
		return (
			grants.every((grant: { code: number | string; out: string }) => grant.code === 0) &&
			narrowed.code === 0 &&
			otherUserRightsIn(dirListing).length === OTHER_USER_PRINCIPALS.length &&
			otherUserRightsIn(fileListing).length === 0
		)
	} catch {
		return false
	} finally {
		runIcacls([probe, "/reset", "/T"])
		fsSync.rmSync(probe, { recursive: true, force: true })
	}
}

const NTFS_ACLS = ntfsAclsUsable()

interface Fixture {
	root: string
	parent: string
	target: string
	parentListing: string
	targetListing: string
}

function dispose(fixture: Fixture): void {
	// Rights first, then removal: a directory narrowed to one account is still removable by its own
	// owner, but resetting on the way out is what makes a failed run leave nothing behind.
	runIcacls([fixture.root, "/reset", "/T"])
	fsSync.rmSync(fixture.root, { recursive: true, force: true })
}

// The row asks for a target whose access list is narrower than the directory holding it. The parent
// is given the rights a staging directory would inherit - read for other users, modify for
// authenticated users - and the target file is narrowed to this account alone, so the difference
// between the two is what every assertion below reads, on any NTFS volume and not only on a parent
// that happened to be permissive.
function makeFixture(): Fixture | null {
	const account = accountForGrant()
	if (account === "") {
		return null
	}
	const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fws-stagedacl-"))
	const parent = path.join(root, "parent")
	fsSync.mkdirSync(parent)
	const target = path.join(parent, "settings.json")
	fsSync.writeFileSync(target, "initial content", "utf8")
	const grants = [
		runIcacls([parent, "/grant:r", "BUILTIN\\Users:(OI)(CI)(RX)"]),
		runIcacls([parent, "/grant:r", "NT AUTHORITY\\Authenticated Users:(OI)(CI)(M)"]),
	]
	const narrowed = runIcacls([target, "/inheritance:r", "/grant:r", account + ":(F)"])
	if (grants.some((grant: { code: number | string; out: string }) => grant.code !== 0) || narrowed.code !== 0) {
		dispose({ root, parent, target, parentListing: "", targetListing: narrowed.out })
		return null
	}
	return { root, parent, target, parentListing: runIcacls([parent]).out, targetListing: runIcacls([target]).out }
}

interface Observation {
	calls: string[]
	failures: string[]
	stagingDirAtNarrow: string
	entriesAtNarrow: string[]
	listingBeforeNarrow: string
	entriesAtDump: string[]
	listingAfterNarrow: string
	stagedFileListing: string
}

// The execFileRunner option is typed as child_process.execFile itself - a callable that also carries
// a __promisify__ property, which a plain function cannot supply. This wrapper implements the four
// argument call the writer actually makes and hands it straight through, and the assertion below is
// the double assertion the option's own type forces on any observer of those commands.
function observingRunner(observation: Observation): typeof execFile {
	const wrapper = (
		cmd: string,
		args: string[],
		options: ExecFileOptions,
		callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void,
	): ChildProcess => {
		const command = args.map((arg: string) => String(arg))
		observation.calls.push(command.join(" "))
		if (command.includes("/inheritance:r")) {
			// The writer is about to restrict the staging directory and has staged nothing in it yet:
			// the listing taken here is the one the directory had from its parent.
			observation.stagingDirAtNarrow = command[0]
			observation.entriesAtNarrow = fsSync.readdirSync(observation.stagingDirAtNarrow)
			observation.listingBeforeNarrow = runIcacls([observation.stagingDirAtNarrow]).out
		}
		if (command.includes("/save")) {
			// The dump is the next icacls command after the restriction, and Step 1 has already written
			// and closed the staged file, so this is the moment the staged content sits in staging.
			observation.entriesAtDump = fsSync.readdirSync(observation.stagingDirAtNarrow)
			observation.listingAfterNarrow = runIcacls([observation.stagingDirAtNarrow]).out
			const staged = observation.entriesAtDump[0] ?? ""
			observation.stagedFileListing =
				staged === "" ? "" : runIcacls([path.join(observation.stagingDirAtNarrow, staged)]).out
		}
		return execFile(
			cmd,
			args,
			options,
			(error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
				// A command that failed is recorded with the exit code icacls reported and the first line of
				// what it said, so the row below can name which of its own commands failed instead of only
				// noticing that something was reported to the caller.
				if (error !== null) {
					const firstLine = String(stderr).split("\n")[0] ?? ""
					observation.failures.push(command.join(" ") + " -> exit " + String(error.code) + " " + firstLine)
				}
				callback(error, stdout, stderr)
			},
		)
	}
	return wrapper as unknown as typeof execFile
}

describe("staging directory access rights on a real NTFS volume", () => {
	it.runIf(NTFS_ACLS)("restricts the staging directory before any content is staged in it", async () => {
		const fixture = makeFixture()
		expect(fixture).not.toBeNull()
		if (fixture === null) {
			return
		}
		try {
			// The control that keeps everything below from being vacuous: a file written into an
			// ordinary directory in the same parent, with nothing restricted, has to show the other
			// users' rights. If this listing method cannot see them when they are there, it proves
			// nothing when it says they are absent.
			const controlDir = path.join(fixture.parent, "control")
			fsSync.mkdirSync(controlDir)
			const controlFile = path.join(controlDir, "staged.txt")
			fsSync.writeFileSync(controlFile, "control content", "utf8")

			const observation: Observation = {
				calls: [],
				failures: [],
				stagingDirAtNarrow: "",
				entriesAtNarrow: [],
				listingBeforeNarrow: "",
				entriesAtDump: [],
				listingAfterNarrow: "",
				stagedFileListing: "",
			}
			const warnings: string[] = []
			await safeWriteText(fixture.target, "staged content", {
				platform: "win32",
				onWarning: (message: string) => warnings.push(message),
				execFileRunner: observingRunner(observation),
			})
			const account = accountForGrant()

			// The restriction is the first icacls command the write issues, and it names this write's
			// own staging directory with a full-control grant to the account the process runs as.
			expect(observation.calls[0]).toContain("/inheritance:r")
			expect(observation.calls[0]).toContain(".file-safety-staging")
			// The staging directory is the one the writer resolved, and the writer resolves the name it
			// was given: on a hosted windows runner the temporary root arrives in its 8.3 short form
			// (a log there reads `C:\Users\RUNNER~1\...` where the resolved path reads
			// `C:\Users\runneradmin\...`), and a locally constructed root can differ in case alone. The
			// row is about which directory holds the staging directory, so it compares the two through
			// the same OS-level resolution the writer's canonicalization reports (realpathSync.native),
			// which is one directory on a machine where the two spellings name the same directory.
			expect(path.dirname(observation.stagingDirAtNarrow)).toBe(fsSync.realpathSync.native(fixture.parent))
			expect(observation.calls[0]).toMatch(/:\(OI\)\(CI\)\(F\)$/)
			expect(observation.calls[0]).toContain(account)

			// Before the restriction ran, the staging directory held the rights its parent passes down,
			// and it was still empty: no byte of the new content had been staged under those rights.
			expect(otherUserRightsIn(observation.listingBeforeNarrow)).toEqual(OTHER_USER_PRINCIPALS)
			expect(observation.entriesAtNarrow).toEqual([])

			// After it ran, no other user holds a right on the staging directory, and this account does.
			expect(otherUserRightsIn(observation.listingAfterNarrow)).toEqual([])
			expect(observation.listingAfterNarrow.toLowerCase()).toContain(account.toLowerCase())

			// The content that was staged afterwards inherited the narrowed rights instead of the
			// parent's, which is the exposure the row reports: before this step it was readable by every
			// user on the machine while it sat in staging.
			expect(observation.entriesAtDump).toHaveLength(1)
			expect(otherUserRightsIn(observation.stagedFileListing)).toEqual([])
			expect(observation.stagedFileListing.toLowerCase()).toContain(account.toLowerCase())

			// The control, measured with the same method in the same parent directory.
			expect(otherUserRightsIn(runIcacls([controlFile]).out).length).toBeGreaterThan(0)
			expect(otherUserRightsIn(runIcacls([controlDir]).out).length).toBeGreaterThan(0)
			expect(otherUserRightsIn(fixture.parentListing).length).toBeGreaterThan(0)

			// The target really was narrower than its parent before the write, and it is still just as
			// narrow afterwards: this step changed the staging directory, not the target's own rights.
			expect(otherUserRightsIn(fixture.targetListing)).toEqual([])
			const publishedListing = runIcacls([fixture.target]).out
			expect(otherUserRightsIn(publishedListing)).toEqual([])
			expect(publishedListing.toLowerCase()).toContain(account.toLowerCase())
			expect(fsSync.readFileSync(fixture.target, "utf8")).toBe("staged content")

			// Nothing about the staging directory itself had to be reported to the caller. The one notice
			// this fixture can produce is the writer's documented, non-fatal restoration posture:
			// icacls /restore asks for privileges an ordinary session is not granted, and measured on
			// this machine it answers "Not all privileges or groups referenced are assigned to the
			// caller" at exit 1300 for a restore onto a directory whether or not the target was narrowed.
			// The published file already carries the narrowed rights it inherited in staging, which the
			// assertions above read, so this row is decided by the staging directory and not by that
			// restore.
			expect(warnings.filter((message: string) => !message.includes("could not be restored"))).toEqual([])
			expect(observation.failures.every((failure: string) => failure.includes("/restore"))).toBe(true)
			expect(warnings.length).toBe(observation.failures.length)
			// And nothing was left beside the target: no staging directory, no access-list dump.
			expect(fsSync.readdirSync(fixture.parent).slice().sort()).toEqual(["control", "settings.json"])
		} finally {
			dispose(fixture)
		}
	})
})
