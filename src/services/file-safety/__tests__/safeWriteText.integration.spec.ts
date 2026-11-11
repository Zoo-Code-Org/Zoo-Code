import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteText } from "../safeWriteText"

// The real icacls against a real file: this spec exists to say what a filesystem ends
// up holding, so the access-rights primitive is invoked here rather than stubbed.
async function runIcacls(args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFile("icacls", args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
	})
}

// Names the outcome of a write instead of throwing, so a case about access rights
// reports which of accepted, denied and some other failure happened rather than
// dying on an errno a reader cannot see.
async function tryWrite(filePath: string): Promise<string> {
	try {
		await fs.writeFile(filePath, "probe")
		return "accepted"
	} catch (error: unknown) {
		const code = (error as { code?: string }).code
		return code === "EACCES" || code === "EPERM" ? "denied" : "other:" + String(code ?? "no code")
	}
}
// No fs mocks in this file: the point is to assert what a real filesystem ends up
// holding after a publish attempt, which the mocked spec cannot show. The failure is
// provoked with real filesystem semantics rather than with a stubbed call.
describe("safeWriteText against a real filesystem", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-text-int-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("publishes the new bytes and leaves no staging or backup residue", async () => {
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")

		// No platform override: the real platform's own durability and ACL steps run, and this
		// case is the successful restore. A failed restore now throws DaclRestoreError after
		// the commit rename has already happened (the focused unit test "win32 DACL: a failed
		// restore is an error and the dump is still unlinked" covers that path), so on a
		// machine where icacls cannot put a saved ACL back into a throwaway temp directory
		// this publish reports that error instead of resolving, and the residue assertions
		// below are reached only where the restore worked.
		await safeWriteText(targetPath, "new bytes", { backup: true })

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("leaves the target bytes untouched when the commit cannot replace it", async () => {
		// A regular file cannot be renamed over a directory, so the backup copy and
		// the commit both fail on a real filesystem with no mocking at all.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow()

		// The directory and its content are exactly as they were, and no backup copy
		// or staging directory was left behind next to them.
		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})

	it("cleans up the staging file when the commit rename itself fails", async () => {
		// With backup:false the backup step is skipped, so this is the only shape of
		// this scenario that reaches Step 4: the rename of the staging FILE over the
		// target DIRECTORY fails (EISDIR / ENOTDIR / EPERM depending on platform), and
		// the cleanup must remove the staging file. The backup:true case above bails
		// out in the backup step and never exercises the commit-failure path.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: false })).rejects.toThrow()

		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})

	it("either carries a denying DACL onto the published file or reports the failed restore", async (ctx) => {
		// The finding behind this case is that the write path never asks whether the
		// target permits writes: both probes it makes on the target carry no mode, so a
		// file whose DACL denies writes while its directory permits replacement publishes
		// anyway, and a probe of fs.access with W_OK against such a file on this machine
		// answers ok, which is the claim this case exists to pin down. That publish is
		// safe only if the denied rights reach the file that arrives by rename, and the
		// assertion below is a disjunction precisely because which branch happens is a
		// machine fact. The deny is on write
		// data rather than generic write because a generic-write deny on this machine also
		// refuses to open the file for reading, which is a different scenario. Gated on the
		// platform rather than skipped wholesale: on Windows a deny that will not take
		// effect is a failure here, not a silent pass.
		if (process.platform !== "win32") {
			ctx.skip()
			return
		}
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")
		const account = process.env.USERNAME ?? os.userInfo().username
		await runIcacls([targetPath, "/deny", account + ":(WD)"])

		// The guard is the deny itself. Until a write has actually been refused, every
		// assertion below would be reporting on rights this machine never applied.
		expect(await tryWrite(targetPath)).toBe("denied")

		const warnings: string[] = []
		await safeWriteText(targetPath, "published bytes", {
			backup: true,
			onPostCommitWarning: (warning) => {
				warnings.push(warning.kind)
			},
		})

		expect(await fs.readFile(targetPath, "utf8")).toBe("published bytes")
		// Residue includes this write's own ACL dump file: a dump left behind is a second
		// artefact naming the same file, which is the thing the naming exists to prevent.
		expect(await fs.readdir(dir)).toEqual(["target.txt"])

		// The two branches below are machine facts, not code facts: icacls /restore needs
		// SeRestorePrivilege, and on a filtered token here it answers Win32 error 1300, so
		// the restore fails and has to be reported, while a runner that holds the privilege
		// carries the rights onto the published file and must report nothing. The bytes at
		// the target arrived by rename, so they are a different file from the one the deny
		// was placed on. What may never happen is silence: a publish that widened access
		// and said neither is the outcome this finding was raised about.
		const carryOver = await tryWrite(targetPath)
		if (warnings.length === 0) {
			// A privileged runner is the only place this row executes on this box, and it
			// executes nowhere when the token is filtered, which is why the sibling branch below
			// is the one that printed here. A publish that carried the rights onto the renamed
			// file and stayed silent is exactly the outcome the finding was raised about, so the
			// silence is asserted rather than assumed.
			expect(warnings).toEqual([])
			expect(carryOver).toBe("denied")
		} else {
			expect(warnings).toEqual(["dacl-restore-failed"])
		}
	})
})
