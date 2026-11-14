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

	it.each([
		"///server/share/docs/**",
		"////server/share/docs/**",
		"\\\\\\server\\share\\docs\\**",
		"\\\\\\\\server\\share\\docs\\**",
	])("treats extra leading separators in a grant as drive-rooted, not UNC: %s", (pattern) => {
		expect(matches("//server/share/docs/private.md", [pattern], "C:/repo")).toBe(false)
		expect(matches("C:/server/share/docs/private.md", [pattern], "C:/repo")).toBe(true)
		expect(matches("//server/share/docs/private.md", ["//server/share/docs/**"], "C:/repo")).toBe(true)
	})

	it.each([
		"///server/share/docs/private.md",
		"////server/share/docs/private.md",
		"\\\\\\server\\share\\docs\\private.md",
		"\\\\\\\\server\\share\\docs\\private.md",
	])("treats extra leading separators in a candidate as drive-rooted, not UNC: %s", (filePath) => {
		expect(matches(filePath, ["//server/share/docs/**"], "C:/repo")).toBe(false)
		expect(matches(filePath, ["C:/server/share/docs/**"], "C:/repo")).toBe(true)
		expect(matches(filePath, ["///server/share/docs/**"], "C:/repo")).toBe(true)
	})

	it.each(["//server//share", "//server///share", "\\\\server\\\\share", "\\\\server\\\\\\share"])(
		"normalizes repeated separators between a UNC server and share: %s",
		(root) => {
			expect(matches("//server/share/docs/private.md", [`${root}/docs/**`], "C:/repo")).toBe(true)
			expect(matches(`${root}/docs/private.md`, ["//server/share/docs/**"], "C:/repo")).toBe(true)
			expect(matches("//server/share/docs/private.md", ["docs/**"], root)).toBe(true)
			expect(matches("docs/private.md", ["//server/share/docs/**"], root)).toBe(true)
			expect(matches("docs/private.md", ["C:/server/share/docs/**"], root)).toBe(false)
			expect(matches("C:/server/share/docs/private.md", [`${root}/docs/**`], "C:/repo")).toBe(false)
		},
	)

	it.each(["//server", "\\\\server"])("treats an incomplete UNC name as drive-rooted: %s", (filePath) => {
		expect(matches(filePath, ["C:/server"], "C:/repo")).toBe(true)
		expect(matches(filePath, ["D:/server"], "C:/repo")).toBe(false)
		expect(matches("C:/server", [filePath], "C:/repo")).toBe(true)
		expect(matches("//server/share/docs/private.md", [filePath], "C:/repo")).toBe(false)
	})

	it.each([
		{
			cwd: "//server/share/../project",
			canonicalCwd: "//server/share/project",
			otherVolume: "//server/project",
		},
		{
			cwd: "\\\\server\\share\\..\\project",
			canonicalCwd: "//server/share/project",
			otherVolume: "//server/project",
		},
		{ cwd: "C:/../D/project", canonicalCwd: "C:/D/project", otherVolume: "D:/project" },
		{ cwd: "C:\\..\\D\\project", canonicalCwd: "C:/D/project", otherVolume: "D:/project" },
	])(
		"clamps parent traversal at the volume when normalizing equivalent workspace roots: $cwd",
		({ cwd, canonicalCwd, otherVolume }) => {
			const input = {
				cwd,
				canonicalCwd,
				filePath: `${canonicalCwd}/docs/private.md`,
			}
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: [`${otherVolume}/docs/**`] })).toBe(false)
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: ["docs/**"] })).toBe(true)
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: [`${canonicalCwd}/docs/**`] })).toBe(true)
			expect(
				matcher().isFileMatchedByPatterns({
					...input,
					patterns: ["docs/**", `!${canonicalCwd}/docs/private.md`],
				}),
			).toBe(false)
			expect(
				matcher().isFileMatchedByPatterns({
					...input,
					patterns: [`!${canonicalCwd}/docs/private.md`, "docs/**"],
				}),
			).toBe(true)
		},
	)

	it.each([undefined, "/ws", "\\ws", "//server/share/ws", "\\\\server\\share\\ws"])(
		"preserves cross-volume wildcard exclusions and their order with workspace %s",
		(cwd) => {
			const input = { filePath: "C:/x/.env", cwd, homeDir: WINDOWS_HOME }
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: ["C:/**", "!/**/.env"] })).toBe(false)
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: ["!/**/.env", "C:/**"] })).toBe(true)
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: ["C:/**", "!/**/.env", "C:/x/.env"] })).toBe(
				true,
			)
			expect(
				matcher().isFileMatchedByPatterns({
					...input,
					filePath: "C:/x/notes.md",
					patterns: ["C:/**", "!/**/.env"],
				}),
			).toBe(true)
			expect(matcher().isFileMatchedByPatterns({ ...input, patterns: ["/**"] })).toBe(false)
		},
	)

	it.each([
		{
			scenario: "a known workspace drive keeps the exclusion on that drive",
			cwd: "D:/ws",
			filePath: "C:/x/.env",
			patterns: ["C:/**", "!/**/.env"],
			allowed: true,
		},
		{
			scenario: "a known workspace drive still excludes its own files",
			cwd: "D:/ws",
			filePath: "D:/x/.env",
			patterns: ["D:/**", "!/**/.env"],
			allowed: false,
		},
		{
			scenario: "a drive-relative workspace preserves exclusions on explicit grants",
			cwd: "C:",
			filePath: "C:/x/.env",
			patterns: ["C:/**", "!/**/.env"],
			allowed: false,
		},
		{
			scenario: "a rooted exclusion cannot address the internal UNC prefix",
			cwd: undefined,
			filePath: "//server/share/x/.env",
			patterns: ["//server/share/**", "!/UNC/**/.env"],
			allowed: true,
		},
		{
			scenario: "a rooted exclusion cannot address the internal ROOT prefix",
			cwd: undefined,
			filePath: "/x/.env",
			patterns: ["/**", "!/ROOT/**/.env"],
			allowed: true,
		},
		{
			scenario: "an explicit UNC exclusion stays separate from drives",
			cwd: undefined,
			filePath: "C:/x/.env",
			patterns: ["C:/**", "!//C/x/.env"],
			allowed: true,
		},
		{
			scenario: "an explicit drive exclusion still blocks that drive",
			cwd: "//server/share/ws",
			filePath: "C:/x/.env",
			patterns: ["C:/**", "!C:/x/.env"],
			allowed: false,
		},
		{
			scenario: "an explicit drive exclusion does not block a different drive",
			cwd: "//server/share/ws",
			filePath: "D:/x/.env",
			patterns: ["D:/**", "!C:/x/.env"],
			allowed: true,
		},
		{
			scenario: "backslash exclusions preserve cross-volume restrictions",
			cwd: "\\\\server\\share\\ws",
			filePath: "C:\\x\\.env",
			patterns: ["C:\\**", "!\\**\\.env"],
			allowed: false,
		},
	])("preserves exclusion scope: $scenario", ({ cwd, filePath, patterns, allowed }) => {
		expect(matcher().isFileMatchedByPatterns({ cwd, filePath, patterns })).toBe(allowed)
	})

	it("checks cross-volume exclusions against an equivalent drive path for a UNC candidate", () => {
		expect(
			matcher().isFileMatchedByPatterns({
				cwd: "//server/share/Project",
				canonicalCwd: "C:/Storage/Project",
				filePath: "//server/share/Project/docs/.env",
				patterns: ["docs/**", "!/C/Storage/**/.env"],
			}),
		).toBe(false)
	})

	it.each(["//server/sh[a]re/project", "\\\\server\\sh[a]re\\project"])(
		"keeps an inherited UNC volume literal in rooted grants and exclusions: %s",
		(cwd) => {
			expect(matches("//server/sh[a]re/docs/notes.md", ["/docs/**"], cwd)).toBe(true)
			expect(matches("\\\\server\\sh[a]re\\docs\\notes.md", ["/docs/**"], cwd)).toBe(true)
			expect(matches("//server/share/docs/notes.md", ["/docs/**"], cwd)).toBe(false)
			expect(matches("//server/shaare/docs/notes.md", ["/docs/**"], cwd)).toBe(false)
			expect(matches("docs/private.md", ["docs/**", "!/project/docs/private.md"], cwd)).toBe(false)
			expect(matches("docs/notes.md", ["docs/**", "!/project/docs/private.md"], cwd)).toBe(true)
		},
	)

	it.each(["//server/sh[a]re/docs/**", "\\\\server\\sh[a]re\\docs\\**"])(
		"preserves user-authored globs in an explicit UNC pattern: %s",
		(pattern) => {
			expect(matches("//server/share/docs/notes.md", [pattern])).toBe(true)
			expect(matches("//server/sh[a]re/docs/notes.md", [pattern])).toBe(false)
			expect(matches("//server/other/docs/notes.md", [pattern])).toBe(false)
		},
	)

	it("keeps share-rooted paths separate from the internal UNC namespace", () => {
		const cwd = "\\\\server\\share\\project"
		const rooted = "/UNC/server/share/project/docs/**"
		expect(matches("docs/private.md", [rooted], cwd)).toBe(false)
		expect(matches("//server/share/project/docs/private.md", [rooted], cwd)).toBe(false)
		expect(matches("//server/share/UNC/server/share/project/docs/private.md", [rooted], cwd)).toBe(true)
		expect(matches("/UNC/server/share/project/docs/private.md", ["docs/**"], cwd)).toBe(false)
		expect(matches("docs/private.md", ["docs/**", `!${rooted}`], cwd)).toBe(true)
	})

	it("resolves share-rooted paths against the workspace share", () => {
		const cwd = "\\\\server\\share\\project"
		expect(matches("//server/share/docs/private.md", ["/docs/**"], cwd)).toBe(true)
		expect(matches("/docs/private.md", ["//server/share/docs/**"], cwd)).toBe(true)
		expect(matches("//other/share/docs/private.md", ["/docs/**"], cwd)).toBe(false)
	})

	it.each(["C:/", "//server/share", "//server/share/"])("matches relative grants at a volume root: %s", (cwd) => {
		const absolutePath = `${cwd.replace(/\/$/, "")}/docs/private.md`
		expect(matches("docs/private.md", ["docs/**"], cwd)).toBe(true)
		expect(matches(absolutePath, ["docs/**"], cwd)).toBe(true)
		expect(matches("docs/private.md", ["docs/**", "!docs/private.md"], cwd)).toBe(false)
		expect(matches(absolutePath, ["docs/**", "!docs/private.md"], cwd)).toBe(false)
	})

	it.each(["C:", "c:", "C:repo"])("does not anchor relative grants to a drive-relative workspace: %s", (cwd) => {
		expect(matcher().toMatcherPattern("docs/**", cwd)).toBeUndefined()
		for (const canonicalCwd of [undefined, "C:/repo"]) {
			for (const filePath of [
				"docs/private.md",
				"../docs/private.md",
				"C:/docs/private.md",
				"C:/repo/docs/private.md",
			]) {
				expect(matcher().isFileMatchedByPatterns({ filePath, cwd, canonicalCwd, patterns: ["docs/**"] })).toBe(
					false,
				)
			}
			expect(
				matcher().isFileMatchedByPatterns({
					filePath: "C:/docs/notes.md",
					cwd,
					canonicalCwd,
					patterns: ["C:/docs/**"],
				}),
			).toBe(true)
			expect(
				matcher().isFileMatchedByPatterns({
					filePath: "C:/docs/private.md",
					cwd,
					canonicalCwd,
					patterns: ["C:/docs/**", "!C:/docs/private.md"],
				}),
			).toBe(false)
			expect(
				matcher().isFileMatchedByPatterns({
					filePath: "../docs/notes.md",
					cwd,
					canonicalCwd,
					patterns: ["C:/docs/**"],
				}),
			).toBe(false)
		}
	})

	it.each(["C:", "C:docs/private.md", "D:docs/private.md"])(
		"does not guess the location of a drive-relative candidate or pattern: %s",
		(filePath) => {
			expect(matches(filePath, ["**"])).toBe(false)
			expect(matcher().toMatcherPattern(filePath, WINDOWS_CWD)).toBeUndefined()
		},
	)

	it("clamps lexical parents at drive and share roots without crossing matcher namespaces", () => {
		const cwd = "\\\\server\\share\\project"
		expect(matches("//server/share/docs/private.md", ["../../../docs/**"], cwd)).toBe(true)
		expect(matches("C:/docs/private.md", ["../../../../C/docs/**"], cwd)).toBe(false)
		expect(matches("../../../../C/docs/private.md", ["C:/docs/**"], cwd)).toBe(false)
		expect(matches("C:/docs/private.md", ["../../../docs/**"], "C:/project")).toBe(true)
		expect(matches("//server/share/docs/private.md", ["../../UNC/server/share/docs/**"], "C:/project")).toBe(false)
	})

	it.each(["//server/sh[a]re/shared/x.md", "\\\\server\\sh[a]re\\shared\\x.md"])(
		"keeps UNC share names literal when resolving a lexical-parent grant: %s",
		(filePath) => {
			const cwd = "\\\\server\\sh[a]re\\project"
			const patterns = ["../shared/x.md"]
			expect(matches(filePath, patterns, cwd)).toBe(true)
			expect(matches("../shared/x.md", patterns, cwd)).toBe(true)
			for (const share of ["share", "shaare"]) {
				expect(matches(`//server/${share}/shared/x.md`, patterns, cwd)).toBe(false)
			}
		},
	)

	it("keeps unknown-volume rooted paths separate from explicit UNC paths", () => {
		expect(
			matcher().isFileMatchedByPatterns({
				filePath: "//server/share/docs/private.md",
				patterns: ["/UNC/server/share/docs/**"],
			}),
		).toBe(false)
		expect(
			matcher().isFileMatchedByPatterns({
				filePath: "/UNC/server/share/docs/private.md",
				patterns: ["//server/share/docs/**"],
			}),
		).toBe(false)
	})

	it("preserves wildcard exclusions spanning drive and UNC workspace roots", () => {
		const rootMatch = (filePath: string, patterns: string[]) =>
			matcher().isFileMatchedByPatterns({
				filePath,
				cwd: "C:/Aliases/Project",
				canonicalCwd: "//server/share/Project",
				patterns,
			})
		for (const filePath of ["docs/private.md", "//server/share/Project/docs/private.md"]) {
			for (const exclusion of ["!C:/Aliases/**/private.md", "!//server/share/Proj*/docs/private.md"]) {
				expect(rootMatch(filePath, ["docs/**", exclusion])).toBe(false)
				expect(rootMatch(filePath, [exclusion, "docs/**"])).toBe(true)
				expect(rootMatch(filePath, ["docs/**", exclusion, "C:/Aliases/Project/docs/private.md"])).toBe(true)
			}
		}
	})

	it.each(["\\\\server\\share\\project\\docs\\notes.md", "//server/share/project/docs/notes.md"])(
		"matches an absolute UNC candidate against a relative grant: %s",
		(filePath) => {
			expect(matches(filePath, ["docs/**"], "\\\\server\\share\\project")).toBe(true)
		},
	)

	it("matches explicit UNC patterns from a local-drive workspace and without a workspace", () => {
		const filePath = "\\\\server\\share\\project\\docs\\notes.md"
		const patterns = ["//server/share/project/docs/**"]
		expect(matches(filePath, patterns)).toBe(true)
		expect(matcher().isFileMatchedByPatterns({ filePath, patterns, homeDir: WINDOWS_HOME })).toBe(true)
	})

	it.each([
		{ cwd: "\\\\alias\\share\\project", canonicalCwd: "\\\\server\\storage\\project" },
		{ cwd: "C:\\Aliases\\Project", canonicalCwd: "\\\\server\\storage\\project" },
		{ cwd: "\\\\alias\\share\\project", canonicalCwd: "D:\\Storage\\Project" },
	])("matches equivalent local and UNC roots ($cwd -> $canonicalCwd)", ({ cwd, canonicalCwd }) => {
		const filePath = `${canonicalCwd}\\DOCS\\NOTES.md`
		const rootMatch = (patterns: string[]) =>
			matcher().isFileMatchedByPatterns({ filePath, cwd, canonicalCwd, patterns, homeDir: WINDOWS_HOME })
		expect(rootMatch(["docs/**"])).toBe(true)
		expect(rootMatch([`${cwd}/docs/**`])).toBe(true)
		expect(rootMatch([`${canonicalCwd}/docs/**`])).toBe(true)
		expect(rootMatch(["docs/**", `!${cwd}/docs/notes.md`])).toBe(false)
		expect(rootMatch(["docs/**", `!${canonicalCwd}/docs/notes.md`])).toBe(false)
		expect(rootMatch(["docs/**", `!${cwd}/docs/notes.md`, `${canonicalCwd}/docs/notes.md`])).toBe(true)
	})

	it("honors UNC exclusions for both relative and absolute candidates", () => {
		const cwd = "\\\\server\\share\\project"
		const patterns = ["docs/**", "!//server/share/project/docs/private.md"]
		expect(matches("docs/private.md", patterns, cwd)).toBe(false)
		expect(matches(`${cwd}\\docs\\private.md`, patterns, cwd)).toBe(false)
		expect(matches(`${cwd}\\docs\\notes.md`, patterns, cwd)).toBe(true)
		expect(matches("docs/private.md", [...patterns, "//server/share/project/docs/private.md"], cwd)).toBe(true)
	})

	it("keeps different UNC servers, shares, and similarly prefixed siblings separate", () => {
		const cwd = "\\\\server\\share\\project"
		for (const filePath of [
			"\\\\other-server\\share\\project\\docs\\notes.md",
			"\\\\server\\other-share\\project\\docs\\notes.md",
			"\\\\server\\share\\project-other\\docs\\notes.md",
		]) {
			expect(matches(filePath, ["docs/**"], cwd)).toBe(false)
		}
	})

	it("does not confuse a UNC server named C with the local C drive", () => {
		expect(matches("C:\\share\\project\\docs\\notes.md", ["docs/**"], "\\\\C\\share\\project")).toBe(false)
		expect(matches("\\\\C\\share\\project\\docs\\notes.md", ["docs/**"], "C:\\share\\project")).toBe(false)
		expect(matches("C:\\share\\project\\docs\\notes.md", ["//C/share/project/docs/**"])).toBe(false)
		expect(matches("\\\\C\\share\\project\\docs\\notes.md", ["C:/share/project/docs/**"])).toBe(false)
	})

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

	it("matches equivalent workspace roots across drives with Windows case and ordered exclusions", () => {
		const rootMatch = (patterns: string[]) =>
			matcher().isFileMatchedByPatterns({
				filePath: "d:\\storage\\project\\DOCS\\NOTES.md",
				cwd: "C:\\Aliases\\Project",
				canonicalCwd: "D:\\Storage\\Project",
				patterns,
			})
		expect(rootMatch(["docs/**"])).toBe(true)
		expect(rootMatch(["c:/aliases/PROJECT/docs/**"])).toBe(true)
		expect(rootMatch(["d:/STORAGE/project/docs/**"])).toBe(true)
		expect(rootMatch(["docs/**", "!c:/aliases/project/docs/notes.md"])).toBe(false)
		expect(rootMatch(["docs/**", "!D:/Storage/Project/docs/notes.md"])).toBe(false)
	})

	it("keeps Windows siblings and lexical-parent outside patterns separate from canonical roots", () => {
		const rootMatch = (filePath: string, patterns: string[]) =>
			matcher().isFileMatchedByPatterns({
				filePath,
				cwd: "C:\\Aliases\\Project",
				canonicalCwd: "D:\\Storage\\Project",
				patterns,
			})
		expect(rootMatch("C:/Aliases/shared/file.md", ["../shared/file.md"])).toBe(true)
		expect(rootMatch("D:/Storage/shared/file.md", ["../shared/file.md"])).toBe(false)
		expect(rootMatch("D:/Storage/shared/file.md", ["D:/Storage/shared/file.md"])).toBe(true)
		expect(rootMatch("D:/Storage/Project-other/docs/file.md", ["docs/**"])).toBe(false)
		expect(rootMatch("D:/Storage/Project-other/docs/file.md", ["C:/Aliases/Project-other/docs/**"])).toBe(false)
	})
})
