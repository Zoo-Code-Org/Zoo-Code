// npx vitest run core/auto-approval/__tests__/windowsPaths.spec.ts

import { isFileMatchedByPatterns } from "../filePatterns"

// On Windows the workspace lives on a drive, so every path the matcher sees
// carries one. That used to break matching outright: patterns went through
// `path.resolve`, which stamps the *current* drive onto a drive-less path, while
// an absolute path reported by a tool kept whatever drive it already had. A
// pattern and a path could therefore end up on different drives and never match,
// which is what made the whole allowlist inert on Windows.
//
// These tests fix the platform explicitly, so they assert Windows behaviour on
// every CI runner rather than only on the Windows one.

const WINDOWS_CWD = "C:\\path\\to\\repo"
const WINDOWS_HOME = "C:\\Users\\me"

const matches = (filePath: string, patterns: string[], cwd: string | undefined = WINDOWS_CWD) =>
	isFileMatchedByPatterns({ filePath, cwd, patterns, isWindows: true, homeDir: WINDOWS_HOME })

describe("matching on Windows", () => {
	it("matches a workspace-relative path against a bare pattern", () => {
		expect(matches("notes.md", ["notes.md"])).toBe(true)
		expect(matches("docs\\notes.md", ["notes.md"])).toBe(true)
	})

	it("matches an absolute in-workspace path against a workspace-relative pattern", () => {
		expect(matches("C:\\path\\to\\repo\\docs\\notes.md", ["docs/notes.md"])).toBe(true)
		expect(matches("C:/path/to/repo/docs/notes.md", ["docs/notes.md"])).toBe(true)
	})

	it("does not match a file outside the workspace against a workspace-relative pattern", () => {
		expect(matches("C:\\other\\notes.md", ["notes.md"])).toBe(false)
	})

	it("matches an absolute pattern that names the drive", () => {
		expect(matches("C:\\tmp\\notes.md", ["C:/tmp/notes.md"])).toBe(true)
		expect(matches("C:\\tmp\\notes.md", ["c:/tmp/notes.md"])).toBe(true)
	})

	// The OS reads a drive-less absolute path as being on the current drive, so
	// the pattern and the path have to be brought onto one drive before matching.
	it("matches a drive-less absolute pattern against a path on the workspace drive", () => {
		expect(matches("C:\\tmp\\notes.md", ["/tmp/notes.md"])).toBe(true)
		expect(matches("/tmp/notes.md", ["/tmp/notes.md"])).toBe(true)
		expect(matches("/tmp/notes.md", ["C:/tmp/notes.md"])).toBe(true)
	})

	it("keeps drives apart", () => {
		expect(matches("D:\\tmp\\notes.md", ["C:/tmp/notes.md"])).toBe(false)
		expect(matches("D:\\tmp\\notes.md", ["/tmp/notes.md"])).toBe(false)
		// A workspace on D: makes the drive-less pattern name D:, not C:.
		expect(matches("D:\\tmp\\notes.md", ["/tmp/notes.md"], "D:\\repo")).toBe(true)
	})

	it("expands ~ to a home directory that carries a drive", () => {
		expect(matches("C:\\Users\\me\\notes.md", ["~/notes.md"])).toBe(true)
		expect(matches("C:\\Users\\other\\notes.md", ["~/notes.md"])).toBe(false)
	})

	it("ignores case, as the filesystem does", () => {
		expect(matches("C:\\path\\to\\repo\\NOTES.md", ["notes.md"])).toBe(true)
		expect(matches("c:\\path\\to\\repo\\notes.md", ["notes.md"])).toBe(true)
	})

	it("resolves a workspace-escaping pattern on the workspace drive", () => {
		expect(matches("C:\\path\\to\\shared\\notes.md", ["../shared/notes.md"])).toBe(true)
	})

	it("still honours negations", () => {
		expect(matches("C:\\path\\to\\repo\\docs\\secret.md", ["docs/**", "!docs/secret.md"])).toBe(false)
		expect(matches("C:\\path\\to\\repo\\docs\\notes.md", ["docs/**", "!docs/secret.md"])).toBe(true)
	})

	// The tests above pass `isWindows` explicitly, which leaves the production
	// default untested. These reproduce the cases the Windows CI run reported as
	// failing, with nothing passed but a workspace on a drive, so that the defaults
	// are what decides them.
	describe("with the platform reported as Windows", () => {
		const realPlatform = process.platform

		beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }))
		afterAll(() => Object.defineProperty(process, "platform", { value: realPlatform }))

		const matchesByDefault = (filePath: string, patterns: string[]) =>
			isFileMatchedByPatterns({ filePath, cwd: WINDOWS_CWD, patterns })

		it("matches a bare pattern against a workspace-relative path", () => {
			expect(matchesByDefault("notes.md", ["notes.md"])).toBe(true)
		})

		it("matches a directory glob", () => {
			expect(matchesByDefault("docs/scratch/a.md", ["docs/scratch/**"])).toBe(true)
		})

		it("confines a bare pattern to the workspace", () => {
			expect(matchesByDefault("C:/path/to/repo/etc/passwd", ["passwd"])).toBe(true)
			expect(matchesByDefault("C:/etc/passwd", ["passwd"])).toBe(false)
		})
	})
})
