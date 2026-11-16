// A scope that cannot be canonicalized has to fail the publish with the filesystem answer it
// got. The walk-up to the nearest existing ancestor exists for a scope that is MISSING; applying
// it to any other failure would build a partly lexical scope root and confine the write to a
// directory nobody named. The failure is chosen by an error code, and the codes that make a
// directory unreadable (EACCES on a locked volume, ELOOP on a link cycle) are not reproducible
// portably, so realpath is doubled here and the assertions name which failure the publish
// reports and which path it names.

import * as os from "os"
import * as path from "path"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import { ConfinedPathEscapeError, safeWriteJson } from "../safeWriteJson"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, realpath: vi.fn() }
})

const mockedRealpath = vi.mocked(fs.realpath)

const createdDirs: string[] = []
async function makeDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

function failureOf(error: unknown): { code: string; path: string } | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined
	}
	const code = "code" in error ? error.code : undefined
	const failedPath = "path" in error ? error.path : undefined
	if (typeof code === "string" && typeof failedPath === "string") {
		return { code, path: failedPath }
	}
	return undefined
}

function fsFailure(code: string, failedPath: string): Error {
	return Object.assign(new Error(`${code}: cannot canonicalize ${failedPath}`), { code, path: failedPath })
}

beforeEach(() => {
	mockedRealpath.mockReset()
})

afterEach(async () => {
	for (const dir of createdDirs) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
	}
	createdDirs.length = 0
})

describe("safeWriteJson confineTo scope canonicalization", () => {
	it("surfaces an unreadable scope as itself instead of adopting the parent as the scope", async () => {
		const scope = await makeDir("zdt-scope-eacces-")
		const target = path.join(scope, "mcp.json")
		mockedRealpath.mockImplementation(async (candidate) => {
			const resolved = path.resolve(String(candidate))
			throw fsFailure("EACCES", resolved)
		})

		const outcome = await safeWriteJson(target, { mcpServers: {} }, { confineTo: scope }).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		const failure = failureOf(outcome)
		// The scope is measured first, and the measurement has to be the one reported: a walk-up on a
		// permission failure would name the parent, and the caller would believe a different
		// directory had been declared as the scope.
		expect(failure?.code).toBe("EACCES")
		expect(failure?.path).toBe(scope)
		expect(mockedRealpath).toHaveBeenCalledTimes(1)
		expect(mockedRealpath).toHaveBeenCalledWith(scope)
		expect(outcome).not.toBeInstanceOf(ConfinedPathEscapeError)
		// Nothing was written: the refusal happens before any filesystem side effect.
		expect(await fs.readdir(scope)).toEqual([])
	})

	it("still walks a missing scope up to its nearest existing ancestor and writes", async () => {
		const parent = await makeDir("zdt-scope-missing-")
		const scope = path.join(parent, "zz-not-created-yet")
		const target = path.join(scope, "mcp.json")
		// Doubled the way the real call behaves: a path that is not on disk rejects with ENOENT,
		// a path that is on disk resolves to itself because this fixture uses no links. The scope is
		// absent when the confinement check runs and present once the publish makes it, so the walk
		// up and the after-the-fact re-verification see the same filesystem the real call would give.
		mockedRealpath.mockImplementation(async (candidate) => {
			const resolved = path.resolve(String(candidate))
			if (fsSync.existsSync(String(candidate))) {
				return resolved
			}
			throw fsFailure("ENOENT", resolved)
		})

		await safeWriteJson(target, { mcpServers: { a: {} } }, { confineTo: scope })

		// The ENOENT branch is the only one allowed to walk: the scope below an existing parent is
		// re-joined onto the canonicalized parent and the write lands inside it.
		expect(JSON.parse(String(await fs.readFile(target, "utf8")))).toEqual({ mcpServers: { a: {} } })
		expect(mockedRealpath).toHaveBeenCalledWith(scope)
	})
})
