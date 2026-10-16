import * as fs from "fs/promises"
import type { ClineSayTool } from "@roo-code/types"
import { checkAutoApproval } from "../index"
import { isFileMatchedByPatterns } from "../filePatterns"
import { baseState, type State } from "./fixtures"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

const CWD = "/aliases/project"
const CANONICAL_CWD = "/storage/project"

function matches(filePath: string, patterns: string[]) {
	return isFileMatchedByPatterns({ filePath, cwd: CWD, canonicalCwd: CANONICAL_CWD, patterns, isWindows: false })
}

function approval(tool: ClineSayTool, state: Partial<State>, cwd: string | undefined = CWD, isProtected = false) {
	return checkAutoApproval({
		state: { ...baseState, ...state },
		cwd,
		ask: "tool",
		text: JSON.stringify(tool),
		isProtected,
	})
}

beforeEach(() => {
	vi.mocked(fs.realpath).mockReset().mockResolvedValue(CANONICAL_CWD)
})

afterEach(() => vi.restoreAllMocks())

describe("read matcher workspace-root equivalence", () => {
	it.each([CWD, CANONICAL_CWD, "docs/private.md"])(
		"preserves wildcard exclusions spanning either root for %s",
		(candidateRoot) => {
			const candidate = candidateRoot === "docs/private.md" ? candidateRoot : `${candidateRoot}/docs/private.md`
			for (const exclusion of ["!/aliases/**/private.md", "!/storage/proj*/docs/private.md"]) {
				expect(matches(candidate, ["docs/**", exclusion])).toBe(false)
				expect(matches(candidate, [exclusion, "docs/**"])).toBe(true)
				expect(matches(candidate, ["docs/**", exclusion, `${CANONICAL_CWD}/docs/private.md`])).toBe(true)
			}
		},
	)

	it.each(["project[1]", "project*", "project?"])("keeps the canonical root %s literal", (name) => {
		const rootMatch = (filePath: string) =>
			isFileMatchedByPatterns({
				filePath,
				cwd: CWD,
				canonicalCwd: `/storage/${name}`,
				patterns: ["docs/**"],
				isWindows: false,
			})
		expect(rootMatch(`/storage/${name}/docs/notes.md`)).toBe(true)
		expect(rootMatch(`${CWD}/docs/notes.md`)).toBe(true)
		expect(rootMatch("/storage/project1/docs/notes.md")).toBe(false)
	})

	it.each(["project[1]", "project*", "project?"])("keeps the lexical root %s literal", (name) => {
		const rootMatch = (filePath: string) =>
			isFileMatchedByPatterns({
				filePath,
				cwd: `/aliases/${name}`,
				canonicalCwd: CANONICAL_CWD,
				patterns: ["docs/**"],
				isWindows: false,
			})
		expect(rootMatch(`/aliases/${name}/docs/notes.md`)).toBe(true)
		expect(rootMatch(`${CANONICAL_CWD}/docs/notes.md`)).toBe(true)
		expect(rootMatch("/aliases/project1/docs/notes.md")).toBe(false)
	})

	it.each([CWD, CANONICAL_CWD])("honors %s exclusions and later re-inclusion in one ordered matcher", (root) => {
		const candidate = `${CANONICAL_CWD}/docs/private.md`
		const exclusion = `!${root}/docs/private.md`

		expect(matches(candidate, ["docs/**", exclusion])).toBe(false)
		expect(matches(candidate, [exclusion, "docs/**"])).toBe(true)
		expect(matches(candidate, ["docs/**", exclusion, `${CWD}/docs/private.md`])).toBe(true)
	})

	it("resolves escaping patterns against the lexical parent, not the canonical parent", () => {
		expect(matches("/aliases/shared/file.md", ["../shared/file.md"])).toBe(true)
		expect(matches("/storage/shared/file.md", ["../shared/file.md"])).toBe(false)
		expect(matches("/storage/shared/file.md", ["/storage/shared/file.md"])).toBe(true)
		expect(matches("/aliases/shared/file.md", ["/storage/shared/file.md"])).toBe(false)
		expect(matches(`${CANONICAL_CWD}/docs/file.md`, ["../project/docs/file.md"])).toBe(true)
	})

	it("does not translate similarly prefixed siblings or permit relative rules to cover other roots", () => {
		expect(matches(`${CANONICAL_CWD}-other/docs/file.md`, ["docs/**"])).toBe(false)
		expect(matches(`${CWD}-other/docs/file.md`, ["docs/**"])).toBe(false)
		expect(matches(`${CANONICAL_CWD}-other/docs/file.md`, [`${CWD}-other/docs/**`])).toBe(false)
		expect(matches(`${CANONICAL_CWD}/docs/file.md`, [`${CWD}-other/docs/**`])).toBe(false)
		expect(matches(`${CWD}-other/docs/file.md`, [`${CWD}-other/docs/**`])).toBe(true)
	})
})

describe("read-only root equivalence approval", () => {
	it("keeps read and write allowlist exclusions independent while writes still imply reads", async () => {
		const tool: ClineSayTool = { tool: "readFile", path: `${CANONICAL_CWD}/docs/private.md` }
		const excludedRead = ["docs/**", `!${CWD}/docs/private.md`]
		const excludedWrite = ["docs/**", `!${CANONICAL_CWD}/docs/private.md`]

		expect(await approval(tool, { allowedReadFiles: excludedRead, allowedWriteFiles: excludedWrite })).toEqual({
			decision: "ask",
		})
		expect(await approval(tool, { allowedReadFiles: excludedRead, allowedWriteFiles: ["docs/**"] })).toEqual({
			decision: "approve",
		})
		expect(await approval(tool, { allowedReadFiles: ["docs/**"], allowedWriteFiles: excludedWrite })).toEqual({
			decision: "approve",
		})
	})

	it("does not extend write matching or protected-file permission when roots are equivalent", async () => {
		const canonicalTool: ClineSayTool = { tool: "newFileCreated", path: `${CANONICAL_CWD}/AGENTS.md` }
		expect(await approval(canonicalTool, { allowedReadFiles: ["*.md"], allowedWriteFiles: ["*.md"] })).toEqual({
			decision: "ask",
		})
		expect(await approval(canonicalTool, { allowedWriteFiles: [`${CANONICAL_CWD}/AGENTS.md`] }, CWD, true)).toEqual(
			{ decision: "ask" },
		)
		expect(
			await approval({ tool: "newFileCreated", path: "AGENTS.md" }, { allowedWriteFiles: ["*.md"] }, CWD, true),
		).toEqual({ decision: "ask" })
		expect(
			await approval(
				{ tool: "listFilesRecursive", path: `${CANONICAL_CWD}/docs` },
				{ allowedReadFiles: ["docs/**"] },
			),
		).toEqual({ decision: "ask" })
		expect(fs.realpath).not.toHaveBeenCalled()
	})

	it("requires every named batch target to match and refuses unnamed targets", async () => {
		const state = { allowedReadFiles: ["docs/**", `!${CWD}/docs/private.md`] }
		const listed = { path: `${CANONICAL_CWD}/docs/notes.md`, lineSnippet: "", key: "notes" }
		const excluded = { path: `${CANONICAL_CWD}/docs/private.md`, lineSnippet: "", key: "private" }
		const outside = { path: "/elsewhere/docs/notes.md", lineSnippet: "", key: "outside" }

		expect(
			await approval(
				{
					tool: "readFile",
					batchFiles: [listed, { path: `${CWD}/docs/other.md`, lineSnippet: "", key: "other" }],
				},
				state,
			),
		).toEqual({ decision: "approve" })
		expect(await approval({ tool: "readFile", batchFiles: [listed, excluded] }, state)).toEqual({ decision: "ask" })
		expect(await approval({ tool: "readFile", batchFiles: [listed, outside] }, state)).toEqual({ decision: "ask" })
		expect(await approval({ tool: "readFile", batchFiles: [listed], additionalFileCount: 1 }, state)).toEqual({
			decision: "ask",
		})
	})

	it.each(["ENOENT", "EACCES"])(
		"does not infer root equivalence when task root resolution fails with %s",
		async (code) => {
			const error = Object.assign(new Error("root unavailable"), { code })
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
			vi.mocked(fs.realpath).mockRejectedValue(error)
			const tool: ClineSayTool = {
				tool: "readFile",
				path: `${CANONICAL_CWD}/docs/notes.md`,
				isOutsideWorkspace: true,
			}

			expect(await approval(tool, { allowedReadFiles: ["docs/**"] })).toEqual({ decision: "ask" })
			expect(await approval(tool, { allowedReadFiles: [`${CWD}/docs/**`] })).toEqual({ decision: "ask" })
			expect(await approval(tool, { allowedReadFiles: [`${CANONICAL_CWD}/docs/**`] })).toEqual({
				decision: "approve",
			})
			expect(errorLog).toHaveBeenCalledTimes(3)
			expect(errorLog).toHaveBeenCalledWith(`[auto-approval] Failed to resolve workspace root ${CWD}:`, error)
		},
	)

	it.each([undefined, ""])("does not resolve workspace-relative grants without a task root: %s", async (cwd) => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
		const text = JSON.stringify({
			tool: "readFile",
			path: `${CANONICAL_CWD}/docs/notes.md`,
			isOutsideWorkspace: true,
		})
		expect(
			await checkAutoApproval({ state: { ...baseState, allowedReadFiles: ["docs/**"] }, cwd, ask: "tool", text }),
		).toEqual({ decision: "ask" })
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedReadFiles: [`${CANONICAL_CWD}/docs/**`] },
				cwd,
				ask: "tool",
				text,
			}),
		).toEqual({ decision: "approve" })
		expect(fs.realpath).not.toHaveBeenCalled()
		expect(errorLog).not.toHaveBeenCalled()
	})
})
