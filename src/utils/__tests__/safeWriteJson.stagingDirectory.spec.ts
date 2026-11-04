import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"

// Capture the actual implementations before the mock factory wraps them, so a mocked realpath or
// stat can delegate to the real one without recursing into itself.
// Typed by the hoisted callback's return type rather than by a cast on undefined: the target types
// are overloaded function types, and casting undefined straight to them is what tsc rejects (TS2352).
const actuals = vi.hoisted(
	(): { realpath?: (typeof import("fs/promises"))["realpath"]; stat?: (typeof import("fs/promises"))["stat"] } => ({
		realpath: undefined,
		stat: undefined,
	}),
)

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	actuals.realpath = actual.realpath
	actuals.stat = actual.stat
	return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) }
})

import * as fs from "fs/promises"

/**
 * Controls on the staging-directory drift guard in safeWriteJson: the re-verification that runs
 * between approving a staging directory beside the publish target and streaming into it. The guard
 * has to keep rejecting a parent that was genuinely replaced by a link, and it must not reject an
 * ordinary write because the approved path is spelled differently from the way the same directory is
 * reported. The alias below is the portable form of the Windows case that broke the windows
 * test:misc lane: on a GitHub runner the temp root arrives spelled with its 8.3 short name
 * (C:\Users\RUNNER~1\AppData\Local\Temp), resolvePublishTarget returns that lexical path for a
 * target that does not exist yet, and realpath reports the long name for that very same directory.
 */
describe("safeWriteJson staging directory drift", () => {
	let tmpRoot = ""

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swj-staging-drift-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		if (tmpRoot) {
			await fs.rm(tmpRoot, { recursive: true, force: true })
			tmpRoot = ""
		}
	})

	it("writes through an alias directory when the target does not exist yet", async () => {
		const referent = path.join(tmpRoot, "referent-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const target = path.join(alias, "settings.json")

		await safeWriteJson(target, { preserved: true })

		const written = await fs.readFile(path.join(referent, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
		// Nothing may be left staged on either spelling of the same directory.
		expect((await fs.readdir(referent)).filter((name) => name.startsWith(".new_"))).toEqual([])
		expect((await fs.readdir(alias)).filter((name) => name.startsWith(".new_"))).toEqual([])
	})

	it("still rejects when the approved directory is replaced by a link before staging", async () => {
		const parent = path.join(tmpRoot, "approved-parent")
		await fs.mkdir(parent, { recursive: true })
		const elsewhere = path.join(tmpRoot, "elsewhere")
		await fs.mkdir(elsewhere, { recursive: true })
		const target = path.join(parent, "settings.json")
		const approvedReal = await actuals.realpath!(parent)
		const elsewhereReal = await actuals.realpath!(elsewhere)
		// The guard canonicalizes the approved directory, stats it, and re-walks it. Arm on the stat -
		// the point between the two walks - and report the walk after it as landing elsewhere, which is
		// what a parent replaced by an outside-pointing link produces.
		let armed = false
		vi.mocked(fs.stat).mockImplementation(async (...args) => {
			if (path.resolve(String(args[0])) === approvedReal) {
				armed = true
			}
			return await actuals.stat!(...args)
		})
		vi.mocked(fs.realpath).mockImplementation(async (...args) => {
			const lexical = path.resolve(String(args[0]))
			if (armed && lexical === approvedReal) {
				return elsewhereReal
			}
			return await actuals.realpath!(...args)
		})

		await expect(safeWriteJson(target, { preserved: true })).rejects.toThrow(/Refusing to stage/)

		// Rejected before staging: nothing reached the directory the guard landed on, and nothing was
		// published under the approved spelling either.
		expect(await fs.readdir(elsewhere)).toEqual([])
		expect((await fs.readdir(parent)).filter((name) => name === "settings.json")).toEqual([])
	})

	it("still rejects when the approved directory no longer exists", async () => {
		const parent = path.join(tmpRoot, "doomed-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "settings.json")
		const approvedReal = await actuals.realpath!(parent)

		vi.mocked(fs.stat).mockImplementation(async (...args) => {
			if (path.resolve(String(args[0])) === approvedReal) {
				const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException
				error.code = "ENOENT"
				throw error
			}
			return await actuals.stat!(...args)
		})

		await expect(safeWriteJson(target, { preserved: true })).rejects.toThrow(/no existing directory/)

		expect((await fs.readdir(parent)).filter((name) => name.startsWith(".new_"))).toEqual([])
	})
})
