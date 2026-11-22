import * as fs from "fs/promises"
import os from "os"
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

const NAMESPACE_ROOTS = [
	"//?/UNC/server/share/repo",
	"\\\\?\\UNC\\server\\share\\repo",
	"//./UNC/server/share/repo",
	"\\\\.\\UNC\\server\\share\\repo",
]
const CWD = "C:/repo"
const UNC_ROOT = "//x/UNC/server/share/repo"
const UNC_FILE = `${UNC_ROOT}/secret.md`
const UNC_GRANT = `${UNC_ROOT}/**`

async function approval(
	tool: "readFile" | "newFileCreated",
	path: string,
	state: Partial<State>,
	cwd = CWD,
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

describe("Windows namespace paths through auto-approval", () => {
	matcherForPlatform("win32")

	beforeEach(() => {
		vi.mocked(fs.realpath).mockReset().mockResolvedValue(CWD)
	})

	afterEach(() => vi.restoreAllMocks())

	describe.each(approvalRoutes)("$name", ({ tool, setting }) => {
		it.each(NAMESPACE_ROOTS)("refuses namespace pattern %s without dropping unsafe rules", async (root) => {
			const pattern = `${root}/**`
			// The question mark in an extended UNC prefix must not act as a server-name glob.
			expect(await approval(tool, UNC_FILE, { [setting]: [pattern] })).toEqual({ decision: "ask" })
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT, pattern] })).toEqual({ decision: "ask" })
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT, `!${pattern}`] })).toEqual({
				decision: "ask",
			})
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT] })).toEqual({ decision: "approve" })
		})

		it.each(NAMESPACE_ROOTS)("refuses a namespace candidate below %s", async (root) => {
			const state = { [setting]: ["//*/UNC/server/share/repo/**"] }
			expect(await approval(tool, `${root}/secret.md`, state)).toEqual({ decision: "ask" })
			expect(await approval(tool, UNC_FILE, state)).toEqual({ decision: "approve" })
		})

		it.each(NAMESPACE_ROOTS)("refuses a namespace workspace %s even for explicit grants", async (cwd) => {
			const state = { [setting]: [UNC_GRANT] }
			expect(await approval(tool, UNC_FILE, state, cwd)).toEqual({ decision: "ask" })
			expect(await approval(tool, UNC_FILE, state, UNC_ROOT)).toEqual({ decision: "approve" })
		})

		it.each(NAMESPACE_ROOTS)("rejects namespace home %s only when a rule expands it", async (home) => {
			vi.spyOn(os, "homedir").mockReturnValue(home)
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT] })).toEqual({ decision: "approve" })
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT, "~/other.md"] })).toEqual({
				decision: "ask",
			})
			expect(await approval(tool, UNC_FILE, { [setting]: [UNC_GRANT, "!~/other.md"] })).toEqual({
				decision: "ask",
			})
		})
	})

	it.each(
		(["allowedReadFiles", "allowedWriteFiles"] as const).flatMap((setting) =>
			NAMESPACE_ROOTS.map((canonicalCwd) => ({ setting, canonicalCwd })),
		),
	)(
		"refuses namespace canonical root $canonicalCwd when $setting grants reads",
		async ({ setting, canonicalCwd }) => {
			vi.mocked(fs.realpath).mockResolvedValue(canonicalCwd)
			expect(await approval("readFile", UNC_FILE, { [setting]: [UNC_GRANT] })).toEqual({ decision: "ask" })
			vi.mocked(fs.realpath).mockResolvedValue(CWD)
			expect(await approval("readFile", UNC_FILE, { [setting]: [UNC_GRANT] })).toEqual({ decision: "approve" })
		},
	)

	it.each(["allowedReadFiles", "allowedWriteFiles"] as const)(
		"keeps an unsafe %s independent of the other read grant",
		async (unsafeSetting) => {
			const unsafePatterns = [UNC_GRANT, "!//?/UNC/server/share/repo/other.md"]
			const state = { allowedReadFiles: [UNC_GRANT], allowedWriteFiles: [UNC_GRANT] }
			state[unsafeSetting] = unsafePatterns
			expect(await approval("readFile", UNC_FILE, state)).toEqual({ decision: "approve" })
			expect(
				await approval("readFile", UNC_FILE, {
					allowedReadFiles: unsafePatterns,
					allowedWriteFiles: unsafePatterns,
				}),
			).toEqual({ decision: "ask" })
			expect(await approval("newFileCreated", UNC_FILE, state)).toEqual({
				decision: unsafeSetting === "allowedWriteFiles" ? "ask" : "approve",
			})
		},
	)

	it.each([
		{ tool: "readFile", allow: "alwaysAllowReadOnly", outside: "alwaysAllowReadOnlyOutsideWorkspace" },
		{ tool: "newFileCreated", allow: "alwaysAllowWrite", outside: "alwaysAllowWriteOutsideWorkspace" },
	] as const)("preserves blanket permissions for $tool", async ({ tool, allow, outside }) => {
		const file = "//?/UNC/server/share/repo/secret.md"
		const state = { allowedReadFiles: ["//?/**"], allowedWriteFiles: ["//?/**"], [allow]: true }
		expect(await approval(tool, file, state)).toEqual({ decision: "ask" })
		expect(await approval(tool, file, { ...state, [outside]: true })).toEqual({ decision: "approve" })
	})
})
