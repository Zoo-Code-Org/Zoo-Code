import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { resolveRealPath } from "../WorkspacePathResolver"

// These tests use real symlinks in a real temp directory (no fs mocking, per #389). Some
// scenarios can't be reproduced everywhere: symlink creation needs privileges on Windows, and
// chmod-based EACCES is meaningless as root. Such cases are skipped at runtime rather than mocked.
const isWindows = process.platform === "win32"
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

/** Lowercase on case-insensitive filesystems, matching the resolver's own normalization. */
const expectCase = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p)

describe("resolveRealPath", () => {
	let tmpRoot: string
	let workspace: string
	let outside: string
	let symlinksSupported = false

	beforeEach(async () => {
		// realpath the temp root so comparisons aren't tripped up by /var -> /private/var (macOS).
		tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "zoo-wpr-")))
		workspace = path.join(tmpRoot, "workspace")
		outside = path.join(tmpRoot, "outside")
		await fs.mkdir(workspace, { recursive: true })
		await fs.mkdir(outside, { recursive: true })

		// Probe symlink support once so symlink-dependent cases can skip cleanly on locked-down hosts.
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
		// Restore permissions on any restricted dir (EACCES test) so cleanup can remove it.
		await fs.chmod(path.join(workspace, "restricted"), 0o755).catch(() => {})
		await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
	})

	it("resolves a symlink inside the workspace that points to a file outside, to the outside path", async () => {
		if (!symlinksSupported) return
		const secret = path.join(outside, "secret.txt")
		await fs.writeFile(secret, "x")
		const link = path.join(workspace, "link.txt")
		await fs.symlink(secret, link)

		const resolved = await resolveRealPath(link)

		expect(resolved).toBe(expectCase(await fs.realpath(secret)))
		expect(resolved.startsWith(expectCase(workspace) + path.sep)).toBe(false)
	})

	it("resolves a symlink inside the workspace that points to a directory outside, to the outside path", async () => {
		if (!symlinksSupported) return
		const outsideDir = path.join(outside, "dir")
		await fs.mkdir(outsideDir)
		const linkDir = path.join(workspace, "linkdir")
		await fs.symlink(outsideDir, linkDir)

		const resolved = await resolveRealPath(linkDir)

		expect(resolved).toBe(expectCase(await fs.realpath(outsideDir)))
	})

	it("resolves a not-yet-created file under a symlinked ancestor by resolving the ancestor and re-appending", async () => {
		if (!symlinksSupported) return
		const outsideDir = path.join(outside, "dir")
		await fs.mkdir(outsideDir)
		const linkDir = path.join(workspace, "linkdir")
		await fs.symlink(outsideDir, linkDir)

		// Neither "nested" nor "new.txt" exists yet — the walk-up must resolve `linkDir` and
		// re-append the trailing segments.
		const notYetCreated = path.join(linkDir, "nested", "new.txt")
		const resolved = await resolveRealPath(notYetCreated)

		expect(resolved).toBe(expectCase(path.join(await fs.realpath(outsideDir), "nested", "new.txt")))
	})

	it("re-throws EACCES instead of swallowing it (fail closed)", async () => {
		if (isWindows || isRoot) return
		const restricted = path.join(workspace, "restricted")
		await fs.mkdir(restricted)
		const target = path.join(restricted, "file.txt")
		await fs.writeFile(target, "x")
		await fs.chmod(restricted, 0o000)

		await expect(resolveRealPath(target)).rejects.toMatchObject({ code: "EACCES" })
	})

	it("re-throws ELOOP for a circular symlink chain", async () => {
		if (!symlinksSupported) return
		const a = path.join(workspace, "a")
		const b = path.join(workspace, "b")
		// a -> b and b -> a is a cycle realpath cannot resolve.
		await fs.symlink(b, a)
		await fs.symlink(a, b)

		await expect(resolveRealPath(a)).rejects.toMatchObject({ code: "ELOOP" })
	})

	it("resolves correctly even with no workspace context (it owns no policy)", async () => {
		const real = path.join(outside, "plain.txt")
		await fs.writeFile(real, "x")

		const resolved = await resolveRealPath(real)

		expect(resolved).toBe(expectCase(await fs.realpath(real)))
	})

	it("case-normalizes the resolved path to lowercase on case-insensitive platforms (e.g. darwin)", async () => {
		const mixed = path.join(outside, "MixedCase.txt")
		await fs.writeFile(mixed, "x")
		const realMixed = await fs.realpath(mixed)

		const originalPlatform = process.platform
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
		try {
			const resolved = await resolveRealPath(mixed)
			expect(resolved).toBe(realMixed.toLowerCase())
			expect(resolved).toContain("mixedcase.txt")
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
		}
	})
})
