// npx vitest run core/auto-approval/__tests__/filePatterns.spec.ts

import os from "os"

import { isFileMatchedByPatterns, toMatcherPattern } from "../filePatterns"

const CWD = "/path/to/repo"

// Both platforms' rules are exercised on whichever platform the tests run on, by
// passing `isWindows` explicitly rather than reading `process.platform`.
const matches = (filePath: string, patterns: string[], cwd: string | undefined = CWD) =>
	isFileMatchedByPatterns({ filePath, cwd, patterns, isWindows: false })

const matchesOnWindows = (filePath: string, patterns: string[], cwd: string | undefined = CWD) =>
	isFileMatchedByPatterns({ filePath, cwd, patterns, isWindows: true })

const homeFromRoot = os.homedir().replace(/\\/g, "/").slice(1)

describe("toMatcherPattern", () => {
	it("prefixes the workspace root and lets a bare filename match in any directory", () => {
		expect(toMatcherPattern("notes.md", CWD)).toBe("/path/to/repo/**/notes.md")
	})

	it("anchors a pattern containing a slash to the workspace root", () => {
		expect(toMatcherPattern("docs/notes.md", CWD)).toBe("/path/to/repo/docs/notes.md")
	})

	it("anchors an explicitly workspace-root-relative pattern", () => {
		expect(toMatcherPattern("./notes.md", CWD)).toBe("/path/to/repo/notes.md")
	})

	it("keeps backslashes, which gitignore uses to escape rather than to separate", () => {
		expect(toMatcherPattern("notes.md\\ ", CWD)).toBe("/path/to/repo/**/notes.md\\ ")
		expect(toMatcherPattern("\\#hash.md", CWD)).toBe("/path/to/repo/**/\\#hash.md")
	})

	it("resolves a workspace-escaping pattern against the workspace root", () => {
		expect(toMatcherPattern("../shared/notes.md", CWD)).toBe("/path/to/shared/notes.md")
	})

	it("expands a leading ~ to the home directory", () => {
		expect(toMatcherPattern("~/notes.md", CWD)).toBe(`/${homeFromRoot}/notes.md`)
	})

	it("keeps a Windows drive as the first path segment", () => {
		expect(toMatcherPattern("C:/tmp/notes.md", CWD)).toBe("/C:/tmp/notes.md")
	})

	it("anchors a negation exactly like the pattern it cancels", () => {
		expect(toMatcherPattern("!notes.md", CWD)).toBe("!/path/to/repo/**/notes.md")
		expect(toMatcherPattern("!/tmp/notes.md", CWD)).toBe("!/tmp/notes.md")
	})

	it.each([
		["an empty pattern", ""],
		["a whitespace-only pattern", "   "],
		["the workspace root itself", "."],
		["the home directory itself", "~"],
		["a directory pattern", "mydir/"],
	])("rejects %s", (_label, pattern) => {
		expect(toMatcherPattern(pattern, CWD)).toBeUndefined()
	})

	it("preserves whitespace, which gitignore syntax treats as significant", () => {
		expect(toMatcherPattern(" notes.md", CWD)).toBe("/path/to/repo/**/ notes.md")
		expect(toMatcherPattern("my notes.md", CWD)).toBe("/path/to/repo/**/my notes.md")
	})

	// See noWorkspaceRoot.spec.ts for why this fails closed.
	it("rejects a workspace-relative pattern when the workspace root is unknown", () => {
		expect(toMatcherPattern("../shared/notes.md", undefined)).toBeUndefined()
		expect(toMatcherPattern("notes.md", undefined)).toBeUndefined()
	})

	it("keeps an absolute pattern usable when the workspace root is unknown", () => {
		expect(toMatcherPattern("/tmp/notes.md", undefined)).toBe("/tmp/notes.md")
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

	// A backslash is a legal character in a filename on other platforms, where
	// `my\file` is one file rather than `file` inside `my`, so it must not be read
	// as a separator there.
	it("treats a backslash in a path as part of the filename off Windows", () => {
		expect(matches("docs\\notes.md", ["docs/notes.md"])).toBe(false)
	})

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
