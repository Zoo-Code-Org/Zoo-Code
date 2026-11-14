import * as fs from "fs/promises"
import type { ClineSayTool } from "@roo-code/types"
import { baseState, type State } from "./fixtures"
import { matcherForPlatform } from "./matcherForPlatform"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

const approvalRoutes = [
	{ name: "read allowlist", tool: "readFile", setting: "allowedReadFiles" },
	{ name: "write allowlist granting reads", tool: "readFile", setting: "allowedWriteFiles" },
	{ name: "write allowlist", tool: "newFileCreated", setting: "allowedWriteFiles" },
] as const

async function approval(
	tool: "readFile" | "newFileCreated",
	path: string,
	cwd: string | undefined,
	state: Partial<State>,
	isProtected = false,
) {
	const { checkAutoApproval } = await import("../index")
	return checkAutoApproval({
		state: { ...baseState, ...state },
		cwd,
		ask: "tool",
		text: JSON.stringify({ tool, path, isOutsideWorkspace: true } satisfies ClineSayTool),
		isProtected,
	})
}

describe("Windows rooted approval rules", () => {
	matcherForPlatform("win32")

	beforeEach(() => {
		// An unresolved root keeps these checks on the lexical Windows paths.
		vi.mocked(fs.realpath).mockReset().mockRejectedValue(new Error("workspace unavailable"))
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	describe.each(approvalRoutes)("$name", ({ tool, setting }) => {
		it.each(["///server/share/docs/**", "\\\\\\server\\share\\docs\\**"])(
			"keeps the rooted pattern %s separate from an explicit UNC grant",
			async (pattern) => {
				const cwd = "C:/repo"
				const uncFile = "//server/share/docs/private.md"
				expect(await approval(tool, uncFile, cwd, { [setting]: [pattern] })).toEqual({ decision: "ask" })
				expect(await approval(tool, "C:/server/share/docs/private.md", cwd, { [setting]: [pattern] })).toEqual({
					decision: "approve",
				})
				expect(await approval(tool, uncFile, cwd, { [setting]: ["//server/share/docs/**"] })).toEqual({
					decision: "approve",
				})
				expect(
					await approval(tool, uncFile, cwd, { [setting]: ["//server/share/docs/**", `!${pattern}`] }),
				).toEqual({ decision: "approve" })
			},
		)

		it.each([undefined, "/ws", "//server/share/ws"])(
			"applies ordered global exclusions when cwd is %s",
			async (cwd) => {
				const patterns = ["C:/**", "!/**/.env"]
				expect(await approval(tool, "C:/x/notes.md", cwd, { [setting]: patterns })).toEqual({
					decision: "approve",
				})
				expect(await approval(tool, "C:/x/.env", cwd, { [setting]: patterns })).toEqual({ decision: "ask" })
				expect(await approval(tool, "C:/x/.env", cwd, { [setting]: [...patterns, "C:/x/.env"] })).toEqual({
					decision: "approve",
				})
			},
		)

		it.each(["//server/sh[a]re/project", "\\\\server\\sh[a]re\\project"])(
			"keeps the inferred UNC share literal for cwd %s",
			async (cwd) => {
				const ownFile = "//server/sh[a]re/project/docs/notes.md"
				const neighborFile = "//server/share/project/docs/notes.md"
				const rootedGrant = { [setting]: ["/project/docs/**"] }
				expect(await approval(tool, ownFile, cwd, rootedGrant)).toEqual({ decision: "approve" })
				expect(await approval(tool, neighborFile, cwd, rootedGrant)).toEqual({ decision: "ask" })

				const patterns = ["//server/**", "!/project/docs/.env"]
				expect(
					await approval(tool, "//server/sh[a]re/project/docs/.env", cwd, { [setting]: patterns }),
				).toEqual({ decision: "ask" })
				expect(await approval(tool, "//server/share/project/docs/.env", cwd, { [setting]: patterns })).toEqual({
					decision: "approve",
				})
				expect(
					await approval(tool, "//server/sh[a]re/project/docs/.env", cwd, {
						[setting]: [...patterns, "/project/docs/.env"],
					}),
				).toEqual({ decision: "approve" })
			},
		)
	})

	it.each(["allowedReadFiles", "allowedWriteFiles"] as const)(
		"keeps UNC parent traversal within the share when %s grants reads",
		async (setting) => {
			const cwd = "//server/share/../project"
			const file = "//server/share/project/docs/private.md"
			vi.mocked(fs.realpath).mockResolvedValue("//server/share/project")
			expect(await approval("readFile", file, cwd, { [setting]: ["//server/project/docs/**"] })).toEqual({
				decision: "ask",
			})
			expect(await approval("readFile", file, cwd, { [setting]: ["//server/share/project/docs/**"] })).toEqual({
				decision: "approve",
			})
			expect(
				await approval("readFile", file, cwd, {
					[setting]: ["//server/share/project/docs/**", "!//server/share/project/docs/private.md"],
				}),
			).toEqual({ decision: "ask" })
		},
	)

	it("applies rooted UNC rules to reads through the verified drive alias", async () => {
		const cwd = "//server/sh[a]re/project"
		vi.mocked(fs.realpath).mockResolvedValue("D:/storage/project")
		const patterns = ["/project/docs/**", "!/**/.env"]
		expect(
			await approval("readFile", "D:/storage/project/docs/notes.md", cwd, { allowedReadFiles: patterns }),
		).toEqual({
			decision: "approve",
		})
		expect(await approval("readFile", "D:/storage/project/docs/.env", cwd, { allowedReadFiles: patterns })).toEqual(
			{
				decision: "ask",
			},
		)
		expect(
			await approval("readFile", "D:/storage/project/docs/.env", cwd, {
				allowedReadFiles: [...patterns, "/project/docs/.env"],
			}),
		).toEqual({ decision: "approve" })
	})

	it.each(["allowedReadFiles", "allowedWriteFiles"] as const)(
		"does not let an exclusion in %s cancel the other list's read grant",
		async (excludedSetting) => {
			const state = { allowedReadFiles: ["C:/**"], allowedWriteFiles: ["C:/**"] }
			state[excludedSetting] = ["C:/**", "!/**/.env"]
			expect(await approval("readFile", "C:/x/.env", "//server/share/ws", state)).toEqual({
				decision: "approve",
			})
			expect(
				await approval("readFile", "C:/x/.env", "//server/share/ws", {
					allowedReadFiles: ["C:/**", "!/**/.env"],
					allowedWriteFiles: ["C:/**", "!/**/.env"],
				}),
			).toEqual({ decision: "ask" })
		},
	)

	it("requires protected-write permission even when a rooted UNC grant matches", async () => {
		const cwd = "//server/sh[a]re/project"
		const path = "//server/sh[a]re/project/AGENTS.md"
		const state = { allowedWriteFiles: ["/project/*.md"] }
		expect(await approval("newFileCreated", path, cwd, state, true)).toEqual({ decision: "ask" })
		expect(
			await approval("newFileCreated", path, cwd, { ...state, alwaysAllowWriteProtected: true }, true),
		).toEqual({ decision: "approve" })
	})
})
