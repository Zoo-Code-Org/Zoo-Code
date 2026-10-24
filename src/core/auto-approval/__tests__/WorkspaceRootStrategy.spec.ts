import { isFileMatchedByPatterns } from "../filePatterns"
import { WorkspaceRootStrategy } from "../strategies/WorkspaceRootStrategy"

describe("WorkspaceRootStrategy.forPlatform", () => {
	afterEach(() => vi.restoreAllMocks())

	it("selects POSIX behavior without interpreting drives, network prefixes, or backslashes", () => {
		const strategy = WorkspaceRootStrategy.forPlatform(false)

		expect(strategy.toMatcherAbsolutePath("/tmp/notes.md", "/C")).toBe("/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("//server/share/notes.md", "/C")).toBe("//server/share/notes.md")
		expect(strategy.toMatcherAbsolutePath("/tmp/my\\file.md", "/C")).toBe("/tmp/my\\file.md")
		expect(strategy.comparisonKey("/tmp/NOTES.md")).toBe("/tmp/NOTES.md")
	})

	it("selects Windows behavior for drives, rooted paths, and the distinct UNC namespace", () => {
		const strategy = WorkspaceRootStrategy.forPlatform(true)

		expect(strategy.toMatcherAbsolutePath("D:/tmp/notes.md", "/C")).toBe("/D/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("/tmp/notes.md", "/C")).toBe("/C/tmp/notes.md")
		expect(strategy.toMatcherAbsolutePath("//server/share/notes.md", "/C")).toBe("/UNC/server/share/notes.md")
		expect(strategy.toMatcherAbsolutePath("//C/share/notes.md", "/C")).not.toBe("/C/share/notes.md")
		expect(strategy.comparisonKey("/D/Tmp/NOTES.md")).toBe("/d/tmp/notes.md")
	})

	it("uses one selected strategy for candidates, every pattern, and both workspace roots", () => {
		const toMatcherAbsolutePath = vi.fn((value: string) => value)
		const normalizeAbsoluteRoot = vi
			.fn<WorkspaceRootStrategy["normalizeAbsoluteRoot"]>()
			.mockReturnValueOnce("/aliases/project")
			.mockReturnValueOnce("/storage/project")
		const comparisonKey = vi.fn((value: string) => value)
		const strategy: WorkspaceRootStrategy = { toMatcherAbsolutePath, normalizeAbsoluteRoot, comparisonKey }
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
		expect(comparisonKey).toHaveBeenCalled()
	})
})
