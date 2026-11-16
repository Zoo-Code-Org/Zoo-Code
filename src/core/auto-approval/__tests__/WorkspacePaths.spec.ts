import { isFileMatchedByPatterns } from "../filePatterns"
import { WorkspacePaths } from "../WorkspacePaths"

const PLATFORMS = [
	{
		platform: "POSIX",
		isWindows: false,
		cwd: "/aliases/project",
		canonicalCwd: "/storage/project",
		root: "/aliases/project",
		canonicalRoot: "/storage/project",
	},
	{
		platform: "Windows",
		isWindows: true,
		cwd: "C:\\Aliases\\Project",
		canonicalCwd: "D:\\Storage\\Project",
		root: "/C/Aliases/Project",
		canonicalRoot: "/D/Storage/Project",
	},
] as const

describe.each(PLATFORMS)("workspace paths on $platform", ({ isWindows, cwd, canonicalCwd, root, canonicalRoot }) => {
	const paths = new WorkspacePaths({ cwd, canonicalCwd, isWindows })

	it.each(["", "/Docs/NOTES.md", "/docs/**"])("preserves both root spellings and the suffix %s", (suffix) => {
		expect(paths.equivalentPaths(`${root}${suffix}`)).toEqual([`${root}${suffix}`, `${canonicalRoot}${suffix}`])
		expect(paths.equivalentPaths(`${canonicalRoot}${suffix}`)).toEqual([
			`${canonicalRoot}${suffix}`,
			`${root}${suffix}`,
		])
	})

	it("does not translate siblings, unrelated roots, or relative paths", () => {
		for (const value of [
			`${root}-other/docs/file.md`,
			`${root}2/file.md`,
			`${canonicalRoot}-other/docs/file.md`,
			"/elsewhere/docs/file.md",
			"docs/file.md",
			"../shared/file.md",
		]) {
			expect(paths.equivalentPaths(value)).toEqual([value])
		}
	})

	it.each([undefined, "", "relative/project", "C:", "C:relative"])(
		"does not infer equivalence from an unknown or relative root: %s",
		(invalidRoot) => {
			const value = `${root}/docs/file.md`
			expect(new WorkspacePaths({ cwd: invalidRoot, canonicalCwd, isWindows }).equivalentPaths(value)).toEqual([
				value,
			])
			expect(new WorkspacePaths({ cwd, canonicalCwd: invalidRoot, isWindows }).equivalentPaths(value)).toEqual([
				value,
			])
		},
	)

	it("does not duplicate a spelling when both roots are identical", () => {
		const identical = new WorkspacePaths({ cwd, canonicalCwd: cwd, isWindows })
		const value = `${root}/docs/file.md`
		expect(identical.equivalentPaths(value)).toEqual([value])
	})

	it("uses the same platform rules for candidates, grants, exclusions, and both roots", () => {
		const matches = (filePath: string, patterns: string[]) =>
			isFileMatchedByPatterns({ filePath, cwd, canonicalCwd, patterns, isWindows })
		const patterns = ["docs/**", `!${cwd}/docs/private.md`, `${cwd}/docs/notes.md`]

		expect(matches(`${canonicalCwd}/docs/notes.md`, patterns)).toBe(true)
		expect(matches(`${canonicalCwd}/docs/private.md`, patterns)).toBe(false)
		expect(matches(`${canonicalCwd}/docs/private.md`, [...patterns, `${canonicalCwd}/docs/private.md`])).toBe(true)
		expect(matches(`${cwd}/docs/notes.md`, [`${canonicalCwd}/docs/**`])).toBe(true)
		expect(matches(`${canonicalCwd}-other/docs/notes.md`, ["docs/**"])).toBe(false)
	})
})

describe("workspace path guards", () => {
	it.each([
		{ value: "/tmp/notes.md", posixAbsolute: true, windowsAbsolute: true, driveRelative: false },
		{ value: "//server/share/notes.md", posixAbsolute: true, windowsAbsolute: true, driveRelative: false },
		{ value: "///tmp/notes.md", posixAbsolute: true, windowsAbsolute: true, driveRelative: false },
		{ value: "C:/notes.md", posixAbsolute: false, windowsAbsolute: true, driveRelative: false },
		{ value: "C:/", posixAbsolute: false, windowsAbsolute: true, driveRelative: false },
		{ value: "C:", posixAbsolute: false, windowsAbsolute: false, driveRelative: true },
		{ value: "c:notes.md", posixAbsolute: false, windowsAbsolute: false, driveRelative: true },
		{ value: "docs/notes.md", posixAbsolute: false, windowsAbsolute: false, driveRelative: false },
		{ value: "../notes.md", posixAbsolute: false, windowsAbsolute: false, driveRelative: false },
		{ value: "", posixAbsolute: false, windowsAbsolute: false, driveRelative: false },
	])(
		"classifies $value independently of the host platform",
		({ value, posixAbsolute, windowsAbsolute, driveRelative }) => {
			const posix = new WorkspacePaths({ isWindows: false })
			const windows = new WorkspacePaths({ isWindows: true })

			expect(posix.isAbsolutePath(value)).toBe(posixAbsolute)
			expect(windows.isAbsolutePath(value)).toBe(windowsAbsolute)
			expect(posix.isDriveRelativePath(value)).toBe(false)
			expect(windows.isDriveRelativePath(value)).toBe(driveRelative)
		},
	)

	it("normalizes backslashes only when they are Windows separators", () => {
		const posix = new WorkspacePaths({ isWindows: false })
		const windows = new WorkspacePaths({ isWindows: true })

		expect(posix.normalizeSeparators("/tmp/my\\file.md")).toBe("/tmp/my\\file.md")
		expect(windows.normalizeSeparators("C:\\repo\\file.md")).toBe("C:/repo/file.md")
		expect(windows.normalizeSeparators("\\\\server\\share\\file.md")).toBe("//server/share/file.md")
		expect(posix.normalizeSeparators("docs/file.md")).toBe("docs/file.md")
		expect(windows.normalizeSeparators("docs/file.md")).toBe("docs/file.md")
	})

	it.each([
		{
			isWindows: false,
			cwd: "/repo",
			workspacePath: "/repo",
			workspaceVolume: "",
			matcherVolume: "",
			canResolve: true,
		},
		{
			isWindows: false,
			cwd: "C:repo",
			workspacePath: "C:repo",
			workspaceVolume: "",
			matcherVolume: "",
			canResolve: true,
		},
		{
			isWindows: false,
			cwd: undefined,
			workspacePath: "",
			workspaceVolume: "",
			matcherVolume: "",
			canResolve: false,
		},
		{ isWindows: false, cwd: "", workspacePath: "", workspaceVolume: "", matcherVolume: "", canResolve: false },
		{
			isWindows: true,
			cwd: "C:\\repo",
			workspacePath: "C:/repo",
			workspaceVolume: "/C",
			matcherVolume: "/C",
			canResolve: true,
		},
		{
			isWindows: true,
			cwd: "//server//share/repo",
			workspacePath: "//server//share/repo",
			workspaceVolume: "/UNC/server/share",
			matcherVolume: "/UNC/server/share",
			canResolve: true,
		},
		{
			isWindows: true,
			cwd: "/repo",
			workspacePath: "/repo",
			workspaceVolume: "",
			matcherVolume: "/ROOT",
			canResolve: true,
		},
		{
			isWindows: true,
			cwd: undefined,
			workspacePath: "",
			workspaceVolume: "",
			matcherVolume: "/ROOT",
			canResolve: false,
		},
		{ isWindows: true, cwd: "", workspacePath: "", workspaceVolume: "", matcherVolume: "/ROOT", canResolve: false },
		{
			isWindows: true,
			cwd: "C:",
			workspacePath: "C:",
			workspaceVolume: "",
			matcherVolume: "/ROOT",
			canResolve: false,
		},
		{
			isWindows: true,
			cwd: "C:repo",
			workspacePath: "C:repo",
			workspaceVolume: "",
			matcherVolume: "/ROOT",
			canResolve: false,
		},
	])(
		"keeps workspace context for $cwd (Windows=$isWindows)",
		({ isWindows, cwd, workspacePath, workspaceVolume, matcherVolume, canResolve }) => {
			const paths = new WorkspacePaths({ cwd, isWindows })

			expect(paths.isWindows).toBe(isWindows)
			expect(paths.workspacePath).toBe(workspacePath)
			expect(paths.workspaceVolume).toBe(workspaceVolume)
			expect(paths.matcherVolume).toBe(matcherVolume)
			expect(paths.canResolveRelativePaths).toBe(canResolve)
		},
	)
})

describe("POSIX workspace paths", () => {
	it("keeps drives, network prefixes, and backslashes literal during conversion", () => {
		const paths = new WorkspacePaths({ cwd: "/repo", isWindows: false })

		expect(paths.toMatcherAbsolutePath("/tmp/notes.md", "/C")).toBe("/tmp/notes.md")
		expect(paths.toMatcherAbsolutePath("//server/share/notes.md", "/C")).toBe("//server/share/notes.md")
		expect(paths.toMatcherAbsolutePath("/tmp/my\\file.md", "/C")).toBe("/tmp/my\\file.md")
	})

	it("compares roots case-sensitively and preserves literal backslashes", () => {
		const paths = new WorkspacePaths({
			cwd: "/aliases/My\\Project",
			canonicalCwd: "/storage/My\\Project",
			isWindows: false,
		})

		expect(paths.equivalentPaths("/aliases/My\\Project/Docs/NOTES.md")).toEqual([
			"/aliases/My\\Project/Docs/NOTES.md",
			"/storage/My\\Project/Docs/NOTES.md",
		])
		for (const value of ["/aliases/my\\project/docs/file.md", "/aliases/My/Project/docs/file.md"]) {
			expect(paths.equivalentPaths(value)).toEqual([value])
		}
	})

	it("normalizes dot segments and trailing separators in both roots", () => {
		const paths = new WorkspacePaths({
			cwd: "/aliases/temporary/../project/",
			canonicalCwd: "/storage/./project/",
			isWindows: false,
		})

		expect(paths.equivalentPaths("/aliases/project/docs/file.md")).toEqual([
			"/aliases/project/docs/file.md",
			"/storage/project/docs/file.md",
		])
		expect(paths.equivalentPaths("/aliases/project/notes.md")).toEqual([
			"/aliases/project/notes.md",
			"/storage/project/notes.md",
		])
	})

	it("does not interpret Windows drive paths as absolute roots", () => {
		const paths = new WorkspacePaths({
			cwd: "C:/aliases/project",
			canonicalCwd: "D:/storage/project",
			isWindows: false,
		})
		const value = "/C/aliases/project/docs/file.md"
		expect(paths.equivalentPaths(value)).toEqual([value])
	})
})

describe("Windows workspace paths", () => {
	it("separates explicit drives and shares from inherited rooted paths", () => {
		const paths = new WorkspacePaths({ cwd: "C:/repo", isWindows: true })

		expect(paths.toMatcherAbsolutePath("D:/tmp/notes.md")).toBe("/D/tmp/notes.md")
		expect(paths.toMatcherAbsolutePath("/tmp/notes.md")).toBe("/C/tmp/notes.md")
		expect(paths.toMatcherAbsolutePath("//server/share/notes.md")).toBe("/UNC/server/share/notes.md")
		expect(paths.toMatcherAbsolutePath("//C/share/notes.md")).toBe("/UNC/C/share/notes.md")
		expect(paths.toMatcherAbsolutePath("/tmp/notes.md", "/D")).toBe("/D/tmp/notes.md")
		expect(paths.toMatcherAbsolutePath("///server/share/notes.md")).toBe("/C/server/share/notes.md")
	})

	it.each([
		["\u0130", "i\u0307", false],
		["\u212a", "K", false],
		["\u00df", "SS", false],
		["\u017f", "S", false],
		["\u03a3", "\u03c2", true],
		["\u03a3", "\u03c3", true],
		["Project[1]", "Project1", false],
		["Project(1)", "Project1", false],
		["Project+", "Projecttt", false],
		["Project", "Project\n", false],
	] as const)("preserves root identity and descendant spelling for %s and %s", (left, right, equal) => {
		for (const [root, candidate] of [
			[left, right],
			[right, left],
		]) {
			const paths = new WorkspacePaths({
				cwd: `C:/aliases/${root}`,
				canonicalCwd: "D:/storage/project",
				isWindows: true,
			})
			const value = `/c/ALIASES/${candidate}/Docs/NOTES.md`
			expect(paths.equivalentPaths(value)).toEqual(equal ? [value, "/D/storage/project/Docs/NOTES.md"] : [value])
			const original = `/C/aliases/${root}/Docs/NOTES.md`
			expect(paths.equivalentPaths(original)).toEqual([original, "/D/storage/project/Docs/NOTES.md"])
		}
	})

	it("checks the boundary in the original spelling before translating a root", () => {
		const paths = new WorkspacePaths({
			cwd: "C:/aliases/\u03a3",
			canonicalCwd: "D:/storage/project",
			isWindows: true,
		})
		for (const suffix of ["-other", "\n", "2"]) {
			const unrelated = `/C/aliases/\u03c2${suffix}/Docs/NOTES.md`
			expect(paths.equivalentPaths(unrelated)).toEqual([unrelated])
		}
	})

	it("compares case-insensitively across drives while preserving the entire suffix", () => {
		const paths = new WorkspacePaths({
			cwd: "C:\\Aliases\\Project",
			canonicalCwd: "D:\\Storage\\Project",
			isWindows: true,
		})
		expect(paths.equivalentPaths("/c/ALIASES/project/Docs/NOTES.md")).toEqual([
			"/c/ALIASES/project/Docs/NOTES.md",
			"/D/Storage/Project/Docs/NOTES.md",
		])
		expect(paths.equivalentPaths("/E/Aliases/Project/Docs/NOTES.md")).toEqual(["/E/Aliases/Project/Docs/NOTES.md"])
	})

	it.each([
		{
			cwd: "C:\\Aliases/temporary/../Project\\",
			canonicalCwd: "D:/Storage/./Project/",
			root: "/C/Aliases/Project",
			canonicalRoot: "/D/Storage/Project",
		},
		{ cwd: "C:/", canonicalCwd: "D:/", root: "/C", canonicalRoot: "/D" },
		{
			cwd: "\\Aliases\\Project",
			canonicalCwd: "/Storage/Project",
			root: "/ROOT/Aliases/Project",
			canonicalRoot: "/ROOT/Storage/Project",
		},
		{
			cwd: "\\\\server\\share\\project",
			canonicalCwd: "\\\\server\\storage\\project",
			root: "/UNC/SERVER/SHARE/project",
			canonicalRoot: "/UNC/server/storage/project",
		},
		{
			cwd: "//server//share/../project",
			canonicalCwd: "D:/storage/project",
			root: "/UNC/server/share/project",
			canonicalRoot: "/D/storage/project",
		},
		{
			cwd: "C:/../../project",
			canonicalCwd: "D:/storage/project",
			root: "/C/project",
			canonicalRoot: "/D/storage/project",
		},
		{
			cwd: "///server/share/project",
			canonicalCwd: "D:/storage/project",
			root: "/ROOT/server/share/project",
			canonicalRoot: "/D/storage/project",
		},
	])("normalizes roots within their drive or share: $cwd", ({ cwd, canonicalCwd, root, canonicalRoot }) => {
		const paths = new WorkspacePaths({ cwd, canonicalCwd, isWindows: true })
		const value = `${root}/Docs/NOTES.md`
		expect(paths.equivalentPaths(value)).toEqual([value, `${canonicalRoot}/Docs/NOTES.md`])
	})

	it("does not turn share-root parents into aliases for another share", () => {
		const paths = new WorkspacePaths({
			cwd: "//server/share/../project",
			canonicalCwd: "D:/storage/project",
			isWindows: true,
		})
		const unrelated = "/UNC/server/project/docs/file.md"
		expect(paths.equivalentPaths(unrelated)).toEqual([unrelated])
	})
})

it.each([false, true])("preserves filesystem-root equivalence (Windows=%s)", (isWindows) => {
	const prefix = isWindows ? "/ROOT" : ""
	const rootToDirectory = new WorkspacePaths({ cwd: "/", canonicalCwd: "/storage", isWindows })
	const directoryToRoot = new WorkspacePaths({ cwd: "/aliases", canonicalCwd: "/", isWindows })

	expect(rootToDirectory.equivalentPaths(`${prefix}/docs/file.md`)).toEqual([
		`${prefix}/docs/file.md`,
		`${prefix}/storage/docs/file.md`,
	])
	expect(directoryToRoot.equivalentPaths(`${prefix}/aliases/docs/file.md`)).toEqual([
		`${prefix}/aliases/docs/file.md`,
		`${prefix}/docs/file.md`,
	])
})
