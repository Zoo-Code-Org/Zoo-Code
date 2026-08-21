// npx vitest run core/auto-approval/__tests__/windowsPaths.spec.ts

// Windows path handling for the allowlists, exercised on every platform.
//
// This spec exists because two rounds of Windows-only CI failures were invisible
// here: the `ignore` library installs extra path checks at import time when
// `process.platform === "win32"`, and one of them rejects any path that looks
// drive-rooted. A candidate such as "C:/repo/notes.md" therefore threw
// `RangeError`, which `isFileMatchedByPatterns` turns into "no match", so the
// allowlists silently granted nothing on Windows while every test passed on Linux.
//
// Nothing here passes `isWindows`, unlike filePatterns.spec.ts, which injects it
// to exercise both platforms' rules from anywhere. Letting it default is the point
// of this spec: the default is what the extension uses, and what both rounds of CI
// failures came in through, so injecting a value would test around the bug.
//
// See posixPaths.spec.ts for the same matcher held to the other platform's rules,
// and matcherForPlatform.ts for why that has to be a separate file.

import { matcherForPlatform } from "./matcherForPlatform"

const WINDOWS_CWD = "C:\\path\\to\\repo"
const WINDOWS_HOME = "C:\\Users\\me"

describe("matching on Windows", () => {
	const matcher = matcherForPlatform("win32")

	// `homeDir` is the one thing still injected, because `os.homedir()` reports the
	// host's home directory, which off Windows carries no drive.
	const matches = (filePath: string, patterns: string[], cwd: string | undefined = WINDOWS_CWD) =>
		matcher().isFileMatchedByPatterns({ filePath, cwd, patterns, homeDir: WINDOWS_HOME })

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

	// The drive becomes a plain path segment for matching, so a directory that
	// happens to share the drive letter's name must not be confused with it.
	it("does not confuse a directory named like a drive with that drive", () => {
		expect(matches("C:\\C\\notes.md", ["C:/notes.md"])).toBe(false)
		expect(matches("C:\\C\\notes.md", ["C:/C/notes.md"])).toBe(true)
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

	// These are the shapes the Windows CI runs reported as failing.
	it("matches a directory glob", () => {
		expect(matches("docs/scratch/a.md", ["docs/scratch/**"])).toBe(true)
	})

	it("confines a bare pattern to the workspace", () => {
		expect(matches("C:/path/to/repo/etc/passwd", ["passwd"])).toBe(true)
		expect(matches("C:/etc/passwd", ["passwd"])).toBe(false)
	})
})
