import { matcherForPlatform } from "./matcherForPlatform"

const CWD = "C:/repo"
const FILE = "C:/repo/docs/notes.md"
const NAMESPACE_ROOTS = [
	String.raw`\\?\UNC\server\share\repo`,
	String.raw`\\.\UNC\server\share\repo`,
	"//?/UNC/server/share/repo",
	"//./UNC/server/share/repo",
	String.raw`\/?/UNC/server/share/repo`,
	String.raw`/\.\UNC/server\share/repo`,
]

describe("Windows namespace paths in file allowlists", () => {
	const matcher = matcherForPlatform("win32")
	type MatchInput = Parameters<ReturnType<typeof matcher>["isFileMatchedByPatterns"]>[0]
	const matches = (overrides: Partial<MatchInput> = {}) =>
		matcher().isFileMatchedByPatterns({ cwd: CWD, filePath: FILE, patterns: ["docs/**"], ...overrides })

	it.each(NAMESPACE_ROOTS)("rejects namespace pattern %s before UNC glob interpretation", (root) => {
		const pattern = `${root}/**`
		expect(matches({ filePath: "//x/UNC/server/share/repo/secret.md", patterns: [pattern] })).toBe(false)
		expect(matcher().toMatcherPattern(pattern, CWD)).toBeUndefined()
		expect(matcher().toMatcherPattern(`!${pattern}`, CWD)).toBeUndefined()
	})

	it.each([
		["//?/UNC/server/share/repo/**", "docs/**"],
		["docs/**", "//?/UNC/server/share/repo/**"],
		["!//?/UNC/server/share/repo/**", "docs/**"],
		["docs/**", "!//?/UNC/server/share/repo/**", "docs/notes.md"],
		["docs/**", "!//./UNC/server/share/repo/", "docs/notes.md"],
	])("rejects the whole list containing an unsupported grant or exclusion: %j", (...patterns) => {
		expect(matches({ patterns })).toBe(false)
	})

	it.each(NAMESPACE_ROOTS)("rejects namespace candidates and workspace roots: %s", (root) => {
		expect(matches({ filePath: `${root}/docs/notes.md`, patterns: ["//*/UNC/server/share/repo/docs/**"] })).toBe(
			false,
		)
		// Even an independent absolute grant must not bypass unsupported workspace context.
		expect(matches({ cwd: root, patterns: [FILE] })).toBe(false)
		expect(matches({ canonicalCwd: root, patterns: [FILE] })).toBe(false)
		expect(matcher().toMatcherPattern(FILE, root)).toBeUndefined()
	})

	it.each(["~/docs/**", String.raw`~\docs\**`, "!~/docs/**", "!~/docs/"])(
		"rejects a namespace home directory when a rule expands it: %s",
		(pattern) => {
			const homeDir = String.raw`\\?\C:\Users\me`
			expect(matcher().toMatcherPattern(pattern, CWD, true, homeDir)).toBeUndefined()
			expect(matches({ homeDir, patterns: ["docs/**", pattern, "docs/notes.md"] })).toBe(false)
		},
	)

	it("ignores an unsupported home directory when no rule expands it", () => {
		const homeDir = String.raw`\\.\C:\Users\me`
		expect(matcher().toMatcherPattern("docs/**", CWD, true, homeDir)).toBe("/C/repo/docs/**")
		expect(matches({ homeDir })).toBe(true)
	})

	it("removes only the first negation marker when identifying a namespace", () => {
		const pattern = "!!//?/UNC/server/share/repo/**"
		expect(matcher().toMatcherPattern(pattern, CWD)).toBe("!/C/repo/!//?/UNC/server/share/repo/**")
		expect(matches({ patterns: ["docs/**", pattern] })).toBe(true)
	})

	it.each([
		{ pattern: "C:/repo/docs/**", filePath: FILE, rewritten: "/C/repo/docs/**" },
		{
			pattern: String.raw`\\server\share\repo\docs\**`,
			filePath: "//server/share/repo/docs/notes.md",
			rewritten: "/UNC/server/share/repo/docs/**",
		},
		{
			pattern: "//server?/share/repo/docs/**",
			filePath: "//server1/share/repo/docs/notes.md",
			rewritten: "/UNC/server?/share/repo/docs/**",
		},
		{ pattern: "~/docs/**", filePath: "C:/Users/me/docs/notes.md", rewritten: "/C/Users/me/docs/**" },
	])("keeps supported drive, UNC, hostname-glob and home rules: $pattern", ({ pattern, filePath, rewritten }) => {
		const homeDir = "C:/Users/me"
		expect(matcher().toMatcherPattern(pattern, CWD, true, homeDir)).toBe(rewritten)
		expect(matches({ filePath, patterns: [pattern], homeDir })).toBe(true)
	})

	it.each(["//?/UNC/server/share/repo", "//./UNC/server/share/repo"])(
		"leaves POSIX interpretation unchanged for %s",
		(cwd) => {
			expect(matcher().toMatcherPattern(`${cwd}/docs/**`, "/repo", false)).toBe(`${cwd}/docs/**`)
			expect(matches({ cwd, filePath: "docs/notes.md", isWindows: false })).toBe(true)
			expect(
				matches({ cwd: "/repo", filePath: "/repo/docs/notes.md", canonicalCwd: cwd, isWindows: false }),
			).toBe(true)
		},
	)
})
