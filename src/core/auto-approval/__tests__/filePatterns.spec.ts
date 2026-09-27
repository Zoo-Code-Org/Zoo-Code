// npx vitest run core/auto-approval/__tests__/filePatterns.spec.ts

import { isFileMatchedByPatterns, toMatcherPattern } from "../filePatterns"

const CWD = "/path/to/repo"

// Both platforms' rules are exercised on whichever platform the tests run on, by
// passing `isWindows` and `homeDir` explicitly instead of reading the real
// platform. Otherwise these assertions would encode the CI runner's OS: on
// Windows a workspace lives on a drive, and `os.homedir()` starts with one.
const HOME = "/home/me"
const WINDOWS_CWD = "C:/path/to/repo"
const WINDOWS_HOME = "C:\\Users\\me"

// `cwd` is spelled out at every call rather than defaulted, since `undefined` is
// itself a case under test (no folder open) and a default would silently replace
// it with a workspace root.
const matches = (filePath: string, patterns: string[], cwd: string | undefined = CWD) =>
	isFileMatchedByPatterns({ filePath, cwd, patterns, isWindows: false, homeDir: HOME })

const matchesOnWindows = (filePath: string, patterns: string[], cwd: string | undefined = WINDOWS_CWD) =>
	isFileMatchedByPatterns({ filePath, cwd, patterns, isWindows: true, homeDir: WINDOWS_HOME })

const toPattern = (pattern: string, cwd: string | undefined) => toMatcherPattern(pattern, cwd, false, HOME)

const toWindowsPattern = (pattern: string, cwd: string | undefined = WINDOWS_CWD) =>
	toMatcherPattern(pattern, cwd, true, WINDOWS_HOME)

describe("toMatcherPattern", () => {
	it("prefixes the workspace root and lets a bare filename match in any directory", () => {
		expect(toPattern("notes.md", CWD)).toBe("/path/to/repo/**/notes.md")
	})

	it("anchors a pattern containing a slash to the workspace root", () => {
		expect(toPattern("docs/notes.md", CWD)).toBe("/path/to/repo/docs/notes.md")
	})

	it("anchors an explicitly workspace-root-relative pattern", () => {
		expect(toPattern("./notes.md", CWD)).toBe("/path/to/repo/notes.md")
	})

	it("keeps backslashes, which gitignore uses to escape rather than to separate", () => {
		expect(toPattern("notes.md\\ ", CWD)).toBe("/path/to/repo/**/notes.md\\ ")
		expect(toPattern("\\#hash.md", CWD)).toBe("/path/to/repo/**/\\#hash.md")
	})

	it("resolves a workspace-escaping pattern against the workspace root", () => {
		expect(toPattern("../shared/notes.md", CWD)).toBe("/path/to/shared/notes.md")
	})

	it("expands a leading ~ to the home directory", () => {
		expect(toPattern("~/notes.md", CWD)).toBe("/home/me/notes.md")
	})

	it("anchors a negation exactly like the pattern it cancels", () => {
		expect(toPattern("!notes.md", CWD)).toBe("!/path/to/repo/**/notes.md")
		expect(toPattern("!/tmp/notes.md", CWD)).toBe("!/tmp/notes.md")
	})

	it.each([
		["an empty pattern", ""],
		["a whitespace-only pattern", "   "],
		["the workspace root itself", "."],
		["the home directory itself", "~"],
		["a directory pattern", "mydir/"],
	])("rejects %s", (_label, pattern) => {
		expect(toPattern(pattern, CWD)).toBeUndefined()
	})

	it("preserves whitespace, which gitignore syntax treats as significant", () => {
		expect(toPattern(" notes.md", CWD)).toBe("/path/to/repo/**/ notes.md")
		expect(toPattern("my notes.md", CWD)).toBe("/path/to/repo/**/my notes.md")
	})

	// See noWorkspaceRoot.spec.ts for why this fails closed.
	it("rejects a workspace-relative pattern when the workspace root is unknown", () => {
		expect(toPattern("../shared/notes.md", undefined)).toBeUndefined()
		expect(toPattern("notes.md", undefined)).toBeUndefined()
	})

	it("keeps an absolute pattern usable when the workspace root is unknown", () => {
		expect(toPattern("/tmp/notes.md", undefined)).toBe("/tmp/notes.md")
	})

	// A drive letter is a Windows concept. Elsewhere `C:` is an ordinary directory
	// name, so `C:/tmp/notes.md` names a file inside it, relative to the workspace.
	describe("on Windows", () => {
		// The colon is dropped, leaving the drive as an ordinary leading path
		// segment; see `toPosixAbsolutePath` for why it cannot stay.
		it("keeps the drive of an absolute pattern as its first path segment", () => {
			expect(toWindowsPattern("D:/tmp/notes.md")).toBe("/D/tmp/notes.md")
		})

		it("gives a drive-less absolute pattern the workspace's drive", () => {
			// The OS reads `/tmp/notes.md` as being on the current drive, so a
			// pattern and a path spelled that way have to end up on one drive;
			// otherwise they could never match.
			expect(toWindowsPattern("/tmp/notes.md")).toBe("/C/tmp/notes.md")
		})

		it("prefixes the workspace root, drive included", () => {
			expect(toWindowsPattern("notes.md")).toBe("/C/path/to/repo/**/notes.md")
			expect(toWindowsPattern("docs/notes.md")).toBe("/C/path/to/repo/docs/notes.md")
		})

		it("expands ~ to a home directory that has a drive", () => {
			expect(toWindowsPattern("~/notes.md")).toBe("/C/Users/me/notes.md")
		})

		it("reads a backslash as a directory separator", () => {
			expect(toWindowsPattern("docs\\notes.md")).toBe("/C/path/to/repo/docs/notes.md")
		})

		it("resolves a workspace-escaping pattern on the workspace drive", () => {
			expect(toWindowsPattern("../shared/notes.md")).toBe("/C/path/to/shared/notes.md")
		})

		it("treats a drive-looking pattern as a directory off Windows", () => {
			expect(toPattern("C:/tmp/notes.md", CWD)).toBe("/path/to/repo/C:/tmp/notes.md")
		})
	})
})

describe("isFileMatchedByPatterns", () => {
	it("does not match when no patterns are configured", () => {
		expect(matches("notes.md", [])).toBe(false)
		expect(isFileMatchedByPatterns({ filePath: "notes.md", cwd: CWD })).toBe(false)
	})

	it("does not match when no path is given", () => {
		expect(isFileMatchedByPatterns({ filePath: undefined, cwd: CWD, patterns: ["notes.md"] })).toBe(false)
	})

	it("matches an exact workspace-relative path", () => {
		expect(matches("docs/notes.md", ["docs/notes.md"])).toBe(true)
	})

	it("does not match a different file", () => {
		expect(matches("docs/other.md", ["docs/notes.md"])).toBe(false)
	})

	it("matches a bare filename in any directory", () => {
		expect(matches("notes.md", ["notes.md"])).toBe(true)
		expect(matches("deeply/nested/notes.md", ["notes.md"])).toBe(true)
	})

	it("restricts an anchored pattern to the workspace root", () => {
		expect(matches("notes.md", ["./notes.md"])).toBe(true)
		expect(matches("deeply/nested/notes.md", ["./notes.md"])).toBe(false)
	})

	it("matches everything under a directory glob", () => {
		expect(matches("docs/scratch/a.md", ["docs/scratch/**"])).toBe(true)
		expect(matches("docs/scratch/nested/b.md", ["docs/scratch/**"])).toBe(true)
		expect(matches("docs/elsewhere/a.md", ["docs/scratch/**"])).toBe(false)
	})

	it("matches an extension glob", () => {
		expect(matches("docs/notes.md", ["*.md"])).toBe(true)
		expect(matches("docs/notes.txt", ["*.md"])).toBe(false)
	})

	it("matches an absolute path against a workspace-relative pattern", () => {
		expect(matches(`${CWD}/docs/notes.md`, ["docs/notes.md"])).toBe(true)
	})

	it("matches a workspace-relative path against an absolute pattern", () => {
		expect(matches("docs/notes.md", [`${CWD}/docs/notes.md`])).toBe(true)
	})

	it("matches a file outside the workspace via an absolute pattern", () => {
		expect(matches("/tmp/notes.md", ["/tmp/notes.md"])).toBe(true)
	})

	it("matches a file outside the workspace via a workspace-escaping pattern", () => {
		expect(matches("../shared/notes.md", ["../shared/notes.md"])).toBe(true)
		expect(matches("/path/to/shared/notes.md", ["../shared/notes.md"])).toBe(true)
	})

	it("does not match a file outside the workspace via a workspace-relative pattern", () => {
		// "notes.md" is scoped to the workspace, so an unrelated absolute path
		// of the same name must not be approved by it.
		expect(matches("/tmp/notes.md", ["notes.md"])).toBe(false)
	})

	it("keeps Windows drives apart", () => {
		expect(matchesOnWindows("C:/tmp/notes.md", ["c:/tmp/notes.md"])).toBe(true)
		expect(matchesOnWindows("D:/tmp/notes.md", ["c:/tmp/notes.md"])).toBe(false)
	})

	it("matches a path that uses Windows separators, on Windows", () => {
		expect(matchesOnWindows("docs\\notes.md", ["docs/notes.md"])).toBe(true)
	})

	// The opposite case, that on non-Windows a backslash is part of the filename, is
	// in posixPaths.spec.ts and cannot be tested here. Injecting `isWindows: false`
	// is not enough, because on a Windows host `ignore` rewrites the backslashes of
	// every path handed to it before any pattern is tested (`checkPath.convert`,
	// installed process-wide at import time), so the candidate arrives as
	// `docs/notes.md` and matches whatever we ask for. Only forcing the platform
	// keeps that conversion uninstalled.

	it("honours an escaped glob character in a pattern", () => {
		expect(matches("docs/a*b.md", ["docs/a\\*b.md"])).toBe(true)
		expect(matches("docs/axb.md", ["docs/a\\*b.md"])).toBe(false)
	})

	it("still matches valid patterns when other entries are unusable", () => {
		expect(matches("docs/notes.md", ["", "mydir/", "docs/notes.md"])).toBe(true)
	})

	it("matches filenames containing spaces", () => {
		expect(matches("docs/my notes.md", ["docs/my notes.md"])).toBe(true)
		expect(matches("docs/ notes.md", ["docs/ notes.md"])).toBe(true)
	})

	it("applies gitignore's trailing-whitespace rule", () => {
		// An unescaped trailing space is dropped from the pattern, so it names
		// the space-free file; escaping it keeps the space.
		expect(matches("docs/notes.md", ["docs/notes.md "])).toBe(true)
		expect(matches("docs/notes.md ", ["docs/notes.md\\ "])).toBe(true)
	})

	it("matches a workspace-relative path when the workspace root is unknown", () => {
		expect(matches("docs/notes.md", ["docs/notes.md"], undefined)).toBe(true)
	})

	it("honours a negation that excludes a file from a broader pattern", () => {
		expect(matches("docs/secret.md", ["docs/**", "!docs/secret.md"])).toBe(false)
		expect(matches("docs/notes.md", ["docs/**", "!docs/secret.md"])).toBe(true)
	})

	// A pattern grants access to a named file, so it must not also grant the
	// different file that differs only in case.
	describe("case sensitivity", () => {
		it("does not match a differently-cased name off Windows", () => {
			expect(matches("NOTES.md", ["notes.md"])).toBe(false)
			expect(matches("Notes.Md", ["notes.md"])).toBe(false)
			expect(matches("DOCS/notes.md", ["docs/notes.md"])).toBe(false)
			expect(matches("notes.md", ["notes.md"])).toBe(true)
		})

		it("ignores case on Windows, whose filesystem does too", () => {
			expect(matchesOnWindows("NOTES.md", ["notes.md"])).toBe(true)
			expect(matchesOnWindows("DOCS/notes.md", ["docs/notes.md"])).toBe(true)
		})
	})

	// A match on a directory must not decide the verdict of the files below it:
	// see the note of the same name in filePatterns.ts.
	describe("patterns that match a directory", () => {
		it("does not grant a directory's contents", () => {
			expect(matches("docs/notes.md", ["docs"])).toBe(false)
			expect(matches("docs/nested/notes.md", ["docs"])).toBe(false)
			expect(matches("elsewhere/docs/notes.md", ["docs"])).toBe(false)
		})

		it("still grants a file that has the pattern's name", () => {
			expect(matches("docs", ["docs"])).toBe(true)
			expect(matches("nested/docs", ["docs"])).toBe(true)
		})

		// A glob that matches a directory's *name* used to grant everything under
		// it. It now grants only the files it matches itself, which for `*.d` are
		// files ending in `.d` rather than the contents of a `build.d/` directory.
		it("does not grant the contents of a directory whose name a glob matches", () => {
			expect(matches("build.d/notes.md", ["*.d"])).toBe(false)
			expect(matches("build.d", ["*.d"])).toBe(true)
		})

		// `*` names any file in any directory, exactly as `notes.md` and `*.md` do,
		// so it does reach every file in the workspace. That is the documented
		// meaning of a pattern without a slash, not the directory behaviour above:
		// every one of those matches is against the file's own path.
		it("keeps a bare wildcard matching files at any depth", () => {
			expect(matches("notes.md", ["*"])).toBe(true)
			expect(matches("nested/notes.md", ["*"])).toBe(true)
			expect(matches("nested/notes.md", ["*.md"])).toBe(true)
		})

		it("keeps a directory glob granting everything below it", () => {
			expect(matches("docs/notes.md", ["docs/**"])).toBe(true)
			expect(matches("docs/nested/deeply/notes.md", ["docs/**"])).toBe(true)
		})

		it("honours a negation at any depth below a directory glob", () => {
			expect(matches("docs/secret.md", ["docs/**", "!docs/secret.md"])).toBe(false)
			expect(matches("docs/private/secret.md", ["docs/**", "!docs/private/secret.md"])).toBe(false)
			expect(matches("docs/private/notes.md", ["docs/**", "!docs/private/secret.md"])).toBe(true)
		})
	})
})
