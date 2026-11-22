import * as fs from "fs/promises"
import os from "os"
import type { ClineSayTool } from "@roo-code/types"
import { baseState } from "./fixtures"
import { matcherForPlatform } from "./matcherForPlatform"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

const HOME = "//server/share/users/me"
const approvalRoutes = [
	{ name: "read allowlist", tool: "readFile", setting: "allowedReadFiles" },
	{ name: "write allowlist granting reads", tool: "readFile", setting: "allowedWriteFiles" },
	{ name: "write allowlist", tool: "newFileCreated", setting: "allowedWriteFiles" },
] as const
const orderedPatterns = [
	{ name: "home grant", patterns: ["~/**"], allowed: true },
	{ name: "repeated-separator home grant", patterns: ["~//**"], allowed: true },
	{ name: "home exclusion", patterns: ["**", "!~/.env"], allowed: false },
	{ name: "repeated-separator home exclusion", patterns: ["**", "!~//.env"], allowed: false },
	{ name: "later home grant", patterns: ["**", "!~/.env", "~/.env"], allowed: true },
] as const

describe("Windows UNC home patterns", () => {
	const matcher = matcherForPlatform("win32")

	beforeEach(() => {
		vi.mocked(fs.realpath).mockReset().mockResolvedValue(HOME)
		vi.spyOn(os, "homedir").mockReturnValue(HOME)
	})

	afterEach(() => vi.restoreAllMocks())

	it.each([
		{ pattern: "~/docs/*.md", expected: "/UNC/server/share/users/me/docs/*.md" },
		{ pattern: "!~/docs/*.md", expected: "!/UNC/server/share/users/me/docs/*.md" },
		{ pattern: "~\\docs\\*.md", expected: "/UNC/server/share/users/me/docs/*.md" },
		{ pattern: "~//docs/notes.md", expected: "/UNC/server/share/users/me/docs/notes.md" },
		{ pattern: "~/../../../shared/*.md", expected: "/UNC/server/share/shared/*.md" },
	])("preserves the home share when rewriting $pattern", ({ pattern, expected }) => {
		expect(matcher().toMatcherPattern(pattern, "C:/workspace")).toBe(expected)
		expect(matcher().toMatcherPattern(pattern, HOME, true, "\\\\server\\share\\users\\me")).toBe(expected)
	})

	it.each([HOME, "C:/workspace", undefined])("keeps a home grant independent of workspace %s", (cwd) => {
		const matches = (filePath: string) =>
			matcher().isFileMatchedByPatterns({ cwd, filePath, patterns: ["~/docs/*.md"] })
		expect(matches(`${HOME}/docs/notes.md`)).toBe(true)
		expect(matches(`${HOME}/docs/notes.txt`)).toBe(false)
		expect(matches("//other/share/users/me/docs/notes.md")).toBe(false)
		expect(matches("//server/other/users/me/docs/notes.md")).toBe(false)
		expect(matches("C:/server/share/users/me/docs/notes.md")).toBe(false)
	})

	it.each(orderedPatterns)("applies the $name in order", ({ patterns, allowed }) => {
		expect(matcher().isFileMatchedByPatterns({ cwd: HOME, filePath: ".env", patterns: [...patterns] })).toBe(
			allowed,
		)
	})

	it.each([HOME, "//server/share"])("clamps home traversal at the share root from %s", (homeDir) => {
		const matches = (filePath: string) =>
			matcher().isFileMatchedByPatterns({
				cwd: "C:/workspace",
				homeDir,
				filePath,
				patterns: ["~/../../../shared/*.md"],
			})
		expect(matches("//server/share/shared/notes.md")).toBe(true)
		expect(matches("//server/shared/notes.md")).toBe(false)
		expect(matches("C:/shared/notes.md")).toBe(false)
	})

	it("keeps filesystem home names literal while preserving suffix globs", () => {
		const homeDir = "//ser[v]er/sh[a]re/users/[me]"
		expect(matcher().toMatcherPattern("~/docs/*.md", HOME, true, homeDir)).toBe(
			"/UNC/ser\\[v\\]er/sh\\[a\\]re/users/\\[me\\]/docs/*.md",
		)
		const matches = (filePath: string) =>
			matcher().isFileMatchedByPatterns({ cwd: HOME, homeDir, filePath, patterns: ["~/docs/*.md"] })
		expect(matches(`${homeDir}/docs/notes.md`)).toBe(true)
		expect(matches("//server/share/users/m/docs/notes.md")).toBe(false)
	})

	it.each([
		{ isWindows: true, homeDir: "D:/Users/me", expected: "/D/Users/me/docs/*.md" },
		{ isWindows: false, homeDir: "/home/me", expected: "/home/me/docs/*.md" },
		{ isWindows: false, homeDir: HOME, expected: "/server/share/users/me/docs/*.md" },
	])("preserves existing home expansion for $homeDir on Windows=$isWindows", ({ isWindows, homeDir, expected }) => {
		expect(matcher().toMatcherPattern("~/docs/*.md", "C:/workspace", isWindows, homeDir)).toBe(expected)
	})

	describe.each(approvalRoutes)("$name", ({ tool, setting }) => {
		it.each(orderedPatterns)("honors the $name through auto-approval", async ({ patterns, allowed }) => {
			const { checkAutoApproval } = await import("../index")
			expect(
				await checkAutoApproval({
					state: { ...baseState, [setting]: [...patterns] },
					cwd: HOME,
					ask: "tool",
					text: JSON.stringify({ tool, path: ".env", isOutsideWorkspace: false } satisfies ClineSayTool),
				}),
			).toEqual({ decision: allowed ? "approve" : "ask" })
		})
	})
})
