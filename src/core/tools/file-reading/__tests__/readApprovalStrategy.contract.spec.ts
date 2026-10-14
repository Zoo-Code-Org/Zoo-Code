import { isFileMatchedByPatterns } from "../../../auto-approval/filePatterns"
import { WorkspaceRootStrategy } from "../../../auto-approval/strategies/WorkspaceRootStrategy"

// Reader-owned coverage keeps the copied approval prerequisite patch unchanged.
describe("reader approval strategy contracts", () => {
	afterEach(() => vi.restoreAllMocks())

	it("keeps a drive-shaped UNC server in the exact Windows network namespace", () => {
		const strategy = WorkspaceRootStrategy.forPlatform(true)

		expect(strategy.toMatcherAbsolutePath("//C/share/notes.md", "/C")).toBe("/UNC/C/share/notes.md")
		expect(strategy.toMatcherAbsolutePath("C:/share/notes.md", "/C")).toBe("/C/share/notes.md")
	})

	it("compares the read candidate and both normalized workspace roots with the selected strategy", () => {
		const candidate = "/storage/project/docs/notes.md"
		const root = "/aliases/project"
		const canonicalRoot = "/storage/project"
		const comparisonKey = vi.fn((value: string) => value)
		const normalizeAbsoluteRoot = vi
			.fn<WorkspaceRootStrategy["normalizeAbsoluteRoot"]>()
			.mockReturnValueOnce(root)
			.mockReturnValueOnce(canonicalRoot)
		const strategy: WorkspaceRootStrategy = {
			toMatcherAbsolutePath: vi.fn((value: string) => value),
			normalizeAbsoluteRoot,
			comparisonKey,
		}
		vi.spyOn(WorkspaceRootStrategy, "forPlatform").mockReturnValue(strategy)

		const matched = isFileMatchedByPatterns({
			filePath: candidate,
			cwd: root,
			canonicalCwd: canonicalRoot,
			patterns: ["docs/**", "!/aliases/project/docs/private.md", "/aliases/project/docs/notes.md"],
			isWindows: false,
		})

		expect(matched).toBe(true)
		expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(1, root)
		expect(normalizeAbsoluteRoot).toHaveBeenNthCalledWith(2, canonicalRoot)
		expect(comparisonKey).toHaveBeenCalledWith(candidate)
		expect(comparisonKey).toHaveBeenCalledWith(root)
		expect(comparisonKey).toHaveBeenCalledWith(canonicalRoot)
	})
})
