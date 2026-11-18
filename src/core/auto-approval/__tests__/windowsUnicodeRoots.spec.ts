import * as fs from "fs/promises"
import { baseState } from "./fixtures"
import { matcherForPlatform } from "./matcherForPlatform"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

const DISTINCT_ROOT_NAMES = [
	{ root: "\u0130", sibling: "i\u0307" },
	{ root: "i\u0307", sibling: "\u0130" },
	{ root: "\u212a", sibling: "K" },
	{ root: "K", sibling: "\u212a" },
] as const

const CANONICAL_CWD = "D:/storage/project"

describe("Windows Unicode workspace-root identity", () => {
	const matcher = matcherForPlatform("win32")

	beforeEach(() => {
		vi.mocked(fs.realpath).mockReset().mockResolvedValue(CANONICAL_CWD)
	})

	it.each(DISTINCT_ROOT_NAMES)(
		"does not translate distinct lexical roots $root and $sibling",
		({ root, sibling }) => {
			const cwd = `C:/aliases/${root}`
			const matches = (filePath: string) =>
				matcher().isFileMatchedByPatterns({
					cwd,
					canonicalCwd: CANONICAL_CWD,
					filePath,
					patterns: ["D:/storage/**"],
				})

			// A broad grant in the canonical parent must not approve another lexical
			// directory through a case fold that expands or changes the root name.
			expect(matches(`C:/aliases/${sibling}/docs/private.md`)).toBe(false)
			expect(matches(`${cwd}-other/docs/private.md`)).toBe(false)
			expect(matches(`${cwd}/Docs/NOTES.md`)).toBe(true)
			expect(matches(`${CANONICAL_CWD}/Docs/NOTES.md`)).toBe(true)
		},
	)

	it.each(DISTINCT_ROOT_NAMES)(
		"does not translate distinct canonical roots $root and $sibling",
		({ root, sibling }) => {
			const cwd = "C:/aliases/project"
			const canonicalCwd = `D:/storage/${root}`
			const matches = (filePath: string) =>
				matcher().isFileMatchedByPatterns({ cwd, canonicalCwd, filePath, patterns: ["C:/aliases/**"] })

			expect(matches(`D:/storage/${sibling}/docs/private.md`)).toBe(false)
			expect(matches(`${canonicalCwd}-other/docs/private.md`)).toBe(false)
			expect(matches(`${canonicalCwd}/Docs/NOTES.md`)).toBe(true)
			expect(matches(`${cwd}/Docs/NOTES.md`)).toBe(true)
		},
	)

	it.each(DISTINCT_ROOT_NAMES)(
		"asks before reading the distinct sibling $sibling of workspace $root",
		async ({ root, sibling }) => {
			const { checkAutoApproval } = await import("../index")
			const cwd = `C:/aliases/${root}`
			const approve = (path: string) =>
				checkAutoApproval({
					cwd,
					state: { ...baseState, allowedReadFiles: ["D:/storage/**"] },
					ask: "tool",
					text: JSON.stringify({ tool: "readFile", path, isOutsideWorkspace: true }),
				})

			expect(await approve(`C:/aliases/${sibling}/docs/private.md`)).toEqual({ decision: "ask" })
			expect(await approve(`${cwd}/docs/notes.md`)).toEqual({ decision: "approve" })
			expect(await approve(`${CANONICAL_CWD}/docs/notes.md`)).toEqual({ decision: "approve" })
		},
	)

	it.each(["\u03c3", "\u03c2"])("keeps sigma case matching and ordered canonical exclusions for %s", (sigma) => {
		const cwd = "C:/aliases/\u03a3"
		const filePath = `C:/aliases/${sigma}/Docs/private.md`
		const matches = (patterns: string[]) =>
			matcher().isFileMatchedByPatterns({ cwd, canonicalCwd: CANONICAL_CWD, filePath, patterns })

		expect(matches(["D:/storage/**"])).toBe(true)
		expect(matches(["C:/aliases/**", `!${CANONICAL_CWD}/Docs/private.md`])).toBe(false)
		expect(matches([`!${CANONICAL_CWD}/Docs/private.md`, "C:/aliases/**"])).toBe(true)
		expect(matches(["C:/aliases/**", `!${CANONICAL_CWD}/Docs/private.md`, filePath])).toBe(true)
		expect(matches([`${CANONICAL_CWD}/Docs/private.md`])).toBe(true)
	})

	it("keeps canonical exclusions effective for a sigma spelling through read approval", async () => {
		const { checkAutoApproval } = await import("../index")
		const cwd = "C:/aliases/\u03a3"
		const path = "C:/aliases/\u03c2/Docs/private.md"
		const approve = (allowedReadFiles: string[]) =>
			checkAutoApproval({
				cwd,
				state: { ...baseState, allowedReadFiles },
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path }),
			})

		expect(await approve(["C:/aliases/**", `!${CANONICAL_CWD}/Docs/private.md`])).toEqual({ decision: "ask" })
		expect(await approve(["C:/aliases/**", `!${CANONICAL_CWD}/Docs/private.md`, path])).toEqual({
			decision: "approve",
		})
	})

	it.each(["Project(1)", "Project+", "Project$", "Project^", "Project{2}", "Project|other"])(
		"keeps regular-expression characters literal in the root %s",
		(name) => {
			const cwd = `C:/aliases/${name}`
			const matches = (filePath: string) =>
				matcher().isFileMatchedByPatterns({
					cwd,
					canonicalCwd: CANONICAL_CWD,
					filePath,
					patterns: ["D:/storage/**"],
				})

			expect(matches(`${cwd}/docs/notes.md`)).toBe(true)
			for (const sibling of ["Project", "Project1", "Projectt", "other"]) {
				expect(matches(`C:/aliases/${sibling}/docs/notes.md`)).toBe(false)
			}
		},
	)
})
