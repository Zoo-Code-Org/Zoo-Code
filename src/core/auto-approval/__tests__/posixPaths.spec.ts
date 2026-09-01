// npx vitest run core/auto-approval/__tests__/posixPaths.spec.ts

// The other half of windowsPaths.spec.ts: the allowlist matcher held to POSIX
// rules, with the platform forced rather than inherited, so that these stay true
// on a Windows CI runner too.
//
// The split into two files is not cosmetic, see matcherForPlatform.ts: `ignore`
// reads the platform once when imported and cannot be re-imported under another.
//
// As in windowsPaths.spec.ts, nothing passes `isWindows`; the default is what is
// under test.

import { matcherForPlatform } from "./matcherForPlatform"

const CWD = "/path/to/repo"

describe("matching off Windows", () => {
	const matcher = matcherForPlatform("linux")

	const matches = (filePath: string, patterns: string[]) =>
		matcher().isFileMatchedByPatterns({ filePath, cwd: CWD, patterns })

	// A backslash is a legal filename character here, where `my\file` is one file
	// rather than `file` inside `my`.
	it("reads a backslash as part of the filename, not as a separator", () => {
		expect(matches("docs\\notes.md", ["docs/notes.md"])).toBe(false)
		expect(matches("docs/notes.md", ["docs/notes.md"])).toBe(true)
	})

	it("distinguishes case", () => {
		expect(matches("NOTES.md", ["notes.md"])).toBe(false)
		expect(matches("notes.md", ["notes.md"])).toBe(true)
	})

	// `C:` is an ordinary directory name here (`mkdir 'C:'` succeeds), so it names
	// a directory in the workspace rather than a drive.
	it("does not read a leading drive as one", () => {
		expect(matches("C:/tmp/notes.md", ["C:/tmp/notes.md"])).toBe(true)
		expect(matches("/tmp/notes.md", ["C:/tmp/notes.md"])).toBe(false)
	})

	it("matches a bare pattern anywhere in the workspace, and nowhere else", () => {
		expect(matches("notes.md", ["notes.md"])).toBe(true)
		expect(matches("deeply/nested/notes.md", ["notes.md"])).toBe(true)
		expect(matches("/tmp/notes.md", ["notes.md"])).toBe(false)
	})

	it("still honours negations", () => {
		expect(matches("docs/secret.md", ["docs/**", "!docs/secret.md"])).toBe(false)
		expect(matches("docs/notes.md", ["docs/**", "!docs/secret.md"])).toBe(true)
	})
})
