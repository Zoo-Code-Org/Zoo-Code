import { isFileMatchedByPatterns } from "../filePatterns"
import { PosixWorkspaceRootStrategy } from "../strategies/PosixWorkspaceRootStrategy"
import { WorkspaceRootStrategy } from "../strategies/WorkspaceRootStrategy"

describe("WorkspaceRootStrategy.forPlatform", () => {
	afterEach(() => vi.restoreAllMocks())

	it("selects POSIX behavior without interpreting drives, network prefixes, or backslashes", () => {
		const strategy = WorkspaceRootStrategy.forPlatform(false)

		expect(strategy.toMatcherAbsolutePath("/tmp/notes.md", "/C")).toBe("/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("//server/share/notes.md", "/C")).toBe("//server/share/notes.md")
		expect(strategy.toMatcherAbsolutePath("/tmp/my\\file.md", "/C")).toBe("/tmp/my\\file.md")
		expect(strategy.pathsEqual("/tmp/NOTES.md", "/tmp/NOTES.md")).toBe(true)
		expect(strategy.pathsEqual("/tmp/NOTES.md", "/tmp/notes.md")).toBe(false)
	})

	it("selects Windows behavior for drives, rooted paths, and the distinct UNC namespace", () => {
		const strategy = WorkspaceRootStrategy.forPlatform(true)

		expect(strategy.toMatcherAbsolutePath("D:/tmp/notes.md", "/C")).toBe("/D/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("/tmp/notes.md", "/C")).toBe("/C/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("//server/share/notes.md", "/C")).toBe("/UNC/server/share/notes.md")
		expect(strategy.toMatcherAbsolutePath("//C/share/notes.md", "/C")).not.toBe("/C/share/notes.md")
		expect(strategy.pathsEqual("/D/Tmp/NOTES.md", "/d/tmp/notes.md")).toBe(true)
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
	] as const)("compares Windows root names %s and %s without rewriting their identity", (left, right, equal) => {
		const strategy = WorkspaceRootStrategy.forPlatform(true)

		expect(strategy.pathsEqual(`/C/aliases/${left}`, `/c/ALIASES/${right}`)).toBe(equal)
		expect(strategy.pathsEqual(`/c/ALIASES/${right}`, `/C/aliases/${left}`)).toBe(equal)
	})

	it("uses one selected strategy for candidates, every pattern, and both workspace roots", () => {
		const strategy = new PosixWorkspaceRootStrategy()
		const toMatcherAbsolutePath = vi.spyOn(strategy, "toMatcherAbsolutePath")
		const normalizeAbsoluteRoot = vi.spyOn(strategy, "normalizeAbsoluteRoot")
		const pathsEqual = vi.spyOn(strategy, "pathsEqual")
		const selectStrategy = vi.spyOn(WorkspaceRootStrategy, "forPlatform").mockReturnValue(strategy)

		expect(
			isFileMatchedByPatterns({
				filePath: "/storage/project/docs/notes.md",
				cwd: "/aliases/project",
				canonicalCwd: "/storage/project",
				patterns: ["docs/**", "!/aliases/project/docs/private.md", "/aliases/project/docs/notes.md"],
				isWindows: false,
			}),
		).toBe(true)

		expect(selectStrategy).toHaveBeenCalledOnce()
		expect(selectStrategy).toHaveBeenCalledWith(false)
		expect(toMatcherAbsolutePath).toHaveBeenCalledWith("/storage/project/docs/notes.md", "")
		expect(toMatcherAbsolutePath).toHaveBeenCalledWith("/aliases/project", "")
		expect(toMatcherAbsolutePath).toHaveBeenCalledWith("/aliases/project/docs/private.md", "")
		expect(toMatcherAbsolutePath).toHaveBeenCalledWith("/aliases/project/docs/notes.md", "")
		expect(normalizeAbsoluteRoot).toHaveBeenCalledTimes(2)
		expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(1, "/aliases/project")
		expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(2, "/storage/project")
		expect(pathsEqual).toHaveBeenCalled()
	})
})
