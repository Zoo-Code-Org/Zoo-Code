import { PosixWorkspaceRootStrategy } from "../strategies/PosixWorkspaceRootStrategy"
import { WindowsWorkspaceRootStrategy } from "../strategies/WindowsWorkspaceRootStrategy"
import { WorkspaceRootStrategy } from "../strategies/WorkspaceRootStrategy"
import { WorkspaceRootCanonicalizer } from "../WorkspaceRootCanonicalizer"

it("normalizes roots once in the factory before any path comparisons", () => {
	const normalizeAbsoluteRoot = vi
		.fn<WorkspaceRootStrategy["normalizeAbsoluteRoot"]>()
		.mockReturnValueOnce("/aliases/project")
		.mockReturnValueOnce("/storage/project")
	const comparisonKey = vi.fn((value: string) => value)
	const strategy: WorkspaceRootStrategy = {
		normalizeAbsoluteRoot,
		comparisonKey,
		toMatcherAbsolutePath: vi.fn((value: string) => value),
	}

	const canonicalizer = WorkspaceRootCanonicalizer.forStrategy("/aliases/project/", "/storage/project/", strategy)

	expect(normalizeAbsoluteRoot).toHaveBeenCalledTimes(2)
	expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(1, "/aliases/project/")
	expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(2, "/storage/project/")
	expect(comparisonKey).not.toHaveBeenCalled()

	expect(canonicalizer.canonicalize("/aliases/project/docs/file.md")).toBe("/storage/project/docs/file.md")
	expect(canonicalizer.canonicalize("/aliases/project/notes.md")).toBe("/storage/project/notes.md")
	expect(normalizeAbsoluteRoot).toHaveBeenCalledTimes(2)
})

describe.each([
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
])("workspace-root canonicalization on $platform", ({ isWindows, cwd, canonicalCwd, root, canonicalRoot }) => {
	const strategy = WorkspaceRootStrategy.forPlatform(isWindows)
	const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(cwd, canonicalCwd, strategy)

	it("translates an exact root and preserves descendant spelling and globs", () => {
		expect(canonicalizer.canonicalize(root)).toBe(canonicalRoot)
		expect(canonicalizer.canonicalize(`${root}/Docs/NOTES.md`)).toBe(`${canonicalRoot}/Docs/NOTES.md`)
		expect(canonicalizer.canonicalize(`${root}/docs/**`)).toBe(`${canonicalRoot}/docs/**`)
	})

	it("does not translate similarly prefixed siblings or lexical parents", () => {
		for (const value of [`${root}-other/docs/file.md`, `${root}2/file.md`, "/elsewhere/docs/file.md"]) {
			expect(canonicalizer.canonicalize(value)).toBe(value)
		}
	})

	it("leaves canonical-root paths and relative values unchanged", () => {
		for (const value of [canonicalRoot, `${canonicalRoot}/docs/file.md`, "docs/file.md", "../shared/file.md"]) {
			expect(canonicalizer.canonicalize(value)).toBe(value)
		}
	})

	it.each([undefined, "", "relative/project", "C:", "C:relative"])(
		"does not infer equivalence from an unknown or relative root: %s",
		(invalidRoot) => {
			const value = `${root}/docs/file.md`
			expect(
				WorkspaceRootCanonicalizer.forStrategy(invalidRoot, canonicalCwd, strategy).canonicalize(value),
			).toBe(value)
			expect(WorkspaceRootCanonicalizer.forStrategy(cwd, invalidRoot, strategy).canonicalize(value)).toBe(value)
		},
	)
})

describe("POSIX workspace-root strategy", () => {
	it("compares case-sensitively and keeps backslashes as filename characters", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"/aliases/My\\Project",
			"/storage/My\\Project",
			new PosixWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/aliases/My\\Project/docs/file.md")).toBe(
			"/storage/My\\Project/docs/file.md",
		)
		expect(canonicalizer.canonicalize("/aliases/my\\project/docs/file.md")).toBe(
			"/aliases/my\\project/docs/file.md",
		)
		expect(canonicalizer.canonicalize("/aliases/My/Project/docs/file.md")).toBe("/aliases/My/Project/docs/file.md")
	})

	it("normalizes root dot segments and trailing separators", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"/aliases/temporary/../project/",
			"/storage/./project/",
			new PosixWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/aliases/project/docs/file.md")).toBe("/storage/project/docs/file.md")
	})

	it("does not interpret Windows drive paths as absolute roots", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"C:/aliases/project",
			"D:/storage/project",
			new PosixWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/C/aliases/project/docs/file.md")).toBe("/C/aliases/project/docs/file.md")
	})
})

describe("Windows workspace-root strategy", () => {
	it("compares case-insensitively across drives without changing descendant case", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"C:\\Aliases\\Project",
			"D:\\Storage\\Project",
			new WindowsWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/c/ALIASES/project/Docs/NOTES.md")).toBe("/D/Storage/Project/Docs/NOTES.md")
		expect(canonicalizer.canonicalize("/E/Aliases/Project/Docs/NOTES.md")).toBe("/E/Aliases/Project/Docs/NOTES.md")
	})

	it("normalizes mixed root separators, dot segments, and trailing separators", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"C:\\Aliases/temporary/../Project\\",
			"D:/Storage/./Project/",
			new WindowsWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/C/Aliases/Project/docs/file.md")).toBe("/D/Storage/Project/docs/file.md")
	})

	it("supports drive roots and drive-less absolute roots in matcher notation", () => {
		const strategy = new WindowsWorkspaceRootStrategy()
		expect(WorkspaceRootCanonicalizer.forStrategy("C:/", "D:/", strategy).canonicalize("/C/docs/file.md")).toBe(
			"/D/docs/file.md",
		)
		expect(
			WorkspaceRootCanonicalizer.forStrategy("\\Aliases\\Project", "/Storage/Project", strategy).canonicalize(
				"/ROOT/Aliases/Project/docs/file.md",
			),
		).toBe("/ROOT/Storage/Project/docs/file.md")
	})

	it("normalizes network roots into the shared UNC matcher namespace", () => {
		const canonicalizer = WorkspaceRootCanonicalizer.forStrategy(
			"\\\\server\\share\\project",
			"\\\\server\\storage\\project",
			new WindowsWorkspaceRootStrategy(),
		)
		expect(canonicalizer.canonicalize("/UNC/SERVER/SHARE/project/docs/file.md")).toBe(
			"/UNC/server/storage/project/docs/file.md",
		)
	})
})

it.each([false, true])("preserves filesystem-root equivalence (Windows=%s)", (isWindows) => {
	const prefix = isWindows ? "/ROOT" : ""
	const strategy = WorkspaceRootStrategy.forPlatform(isWindows)
	expect(
		WorkspaceRootCanonicalizer.forStrategy("/", "/storage", strategy).canonicalize(`${prefix}/docs/file.md`),
	).toBe(`${prefix}/storage/docs/file.md`)
	expect(
		WorkspaceRootCanonicalizer.forStrategy("/aliases", "/", strategy).canonicalize(
			`${prefix}/aliases/docs/file.md`,
		),
	).toBe(`${prefix}/docs/file.md`)
})
