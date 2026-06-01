import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import * as vscode from "vscode"

import type { Task } from "../../task/Task"
import { authorizeRead, authorizeWrite } from "../WorkspaceFileAccess"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [] as { uri: { fsPath: string } }[] },
}))

// Real symlinks in a real temp directory (no fs mocking, per #389/#390). Some scenarios can't be
// reproduced everywhere: symlink creation needs privileges on Windows, and chmod-based EACCES is
// meaningless as root. Such cases are skipped at runtime rather than mocked.
const isWindows = process.platform === "win32"
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

/** Lowercase on case-insensitive filesystems, matching the resolver's own normalization. */
const expectCase = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p)

/** Minimal Task stub exposing only what WorkspaceFileAccess reads. */
function makeTask(opts: { allow?: boolean; providerGone?: boolean; getStateThrows?: boolean } = {}): Task {
	const provider = {
		getState: async () => {
			if (opts.getStateThrows) {
				throw new Error("provider torn down")
			}
			return { allowSymlinksOutsideWorkspace: opts.allow }
		},
	}
	return {
		providerRef: { deref: () => (opts.providerGone ? undefined : provider) },
	} as unknown as Task
}

function setWorkspaceFolders(...paths: string[]) {
	;(vscode.workspace as any).workspaceFolders = paths.map((p) => ({ uri: { fsPath: p } }))
}

describe("WorkspaceFileAccess", () => {
	let tmpRoot: string
	let workspace: string
	let outside: string
	let symlinksSupported = false

	beforeEach(async () => {
		// realpath the temp root so comparisons aren't tripped up by /var -> /private/var (macOS).
		tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-wfa-")))
		workspace = path.join(tmpRoot, "workspace")
		outside = path.join(tmpRoot, "outside")
		await fs.mkdir(workspace, { recursive: true })
		await fs.mkdir(outside, { recursive: true })
		setWorkspaceFolders(workspace)

		const probeTarget = path.join(tmpRoot, "probe-target")
		const probeLink = path.join(tmpRoot, "probe-link")
		await fs.writeFile(probeTarget, "probe")
		try {
			await fs.symlink(probeTarget, probeLink)
			symlinksSupported = true
		} catch {
			symlinksSupported = false
		}
	})

	afterEach(async () => {
		await fs.chmod(path.join(workspace, "restricted"), 0o755).catch(() => {})
		await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
		;(vscode.workspace as any).workspaceFolders = []
	})

	it("authorizes a real file inside the workspace and returns its canonical path", async () => {
		const file = path.join(workspace, "file.txt")
		await fs.writeFile(file, "x")

		const result = await authorizeRead({ task: makeTask(), requestedPath: file, source: "read_file" })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.resolvedPath).toBe(expectCase(await fs.realpath(file)))
		}
	})

	it("denies a symlink inside the workspace that escapes it (symlink_escapes_workspace)", async () => {
		if (!symlinksSupported) return
		const secret = path.join(outside, "secret.txt")
		await fs.writeFile(secret, "x")
		const link = path.join(workspace, "link.txt")
		await fs.symlink(secret, link)

		const result = await authorizeRead({ task: makeTask(), requestedPath: link, source: "read_file" })

		expect(result).toMatchObject({ ok: false, reason: "symlink_escapes_workspace" })
	})

	it("allows an escaping symlink when allowSymlinksOutsideWorkspace is true", async () => {
		if (!symlinksSupported) return
		const secret = path.join(outside, "secret.txt")
		await fs.writeFile(secret, "x")
		const link = path.join(workspace, "link.txt")
		await fs.symlink(secret, link)

		const result = await authorizeRead({ task: makeTask({ allow: true }), requestedPath: link, source: "read_file" })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.resolvedPath).toBe(expectCase(await fs.realpath(secret)))
		}
	})

	it("denies a path that is plainly outside the workspace (outside_workspace)", async () => {
		const file = path.join(outside, "file.txt")
		await fs.writeFile(file, "x")

		const result = await authorizeRead({ task: makeTask(), requestedPath: file, source: "read_file" })

		expect(result).toMatchObject({ ok: false, reason: "outside_workspace" })
	})

	it("returns permission_denied when the path cannot be resolved due to EACCES", async () => {
		if (isWindows || isRoot) return
		const restricted = path.join(workspace, "restricted")
		await fs.mkdir(restricted)
		const target = path.join(restricted, "file.txt")
		await fs.writeFile(target, "x")
		await fs.chmod(restricted, 0o000)

		const result = await authorizeRead({ task: makeTask(), requestedPath: target, source: "read_file" })

		expect(result).toMatchObject({ ok: false, reason: "permission_denied" })
	})

	it("authorizes a not-yet-created file under a symlinked ancestor that stays inside the workspace", async () => {
		if (!symlinksSupported) return
		const realDir = path.join(workspace, "real-dir")
		await fs.mkdir(realDir)
		const linkDir = path.join(workspace, "link-dir")
		await fs.symlink(realDir, linkDir)
		const newFile = path.join(linkDir, "not-created-yet.txt")

		const result = await authorizeWrite({ task: makeTask(), requestedPath: newFile, source: "write_to_file" })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.resolvedPath).toBe(expectCase(path.join(await fs.realpath(realDir), "not-created-yet.txt")))
		}
	})

	it("fails closed when the provider has been torn down (deref returns undefined)", async () => {
		if (!symlinksSupported) return
		const secret = path.join(outside, "secret.txt")
		await fs.writeFile(secret, "x")
		const link = path.join(workspace, "link.txt")
		await fs.symlink(secret, link)

		// providerGone => allowSymlinksOutsideWorkspace defaults to false => symlink is followed and blocked.
		const result = await authorizeRead({
			task: makeTask({ providerGone: true }),
			requestedPath: link,
			source: "read_file",
		})

		expect(result).toMatchObject({ ok: false, reason: "symlink_escapes_workspace" })
	})

	it("fails closed when reading provider state throws", async () => {
		if (!symlinksSupported) return
		const secret = path.join(outside, "secret.txt")
		await fs.writeFile(secret, "x")
		const link = path.join(workspace, "link.txt")
		await fs.symlink(secret, link)

		const result = await authorizeRead({
			task: makeTask({ getStateThrows: true }),
			requestedPath: link,
			source: "read_file",
		})

		expect(result).toMatchObject({ ok: false, reason: "symlink_escapes_workspace" })
	})

	it("fails closed when no workspace folder is open", async () => {
		;(vscode.workspace as any).workspaceFolders = []
		const file = path.join(workspace, "file.txt")
		await fs.writeFile(file, "x")

		const result = await authorizeWrite({ task: makeTask(), requestedPath: file, source: "write_to_file" })

		expect(result).toMatchObject({ ok: false, reason: "outside_workspace" })
	})
})
