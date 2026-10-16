import * as fs from "fs/promises"
import { baseState } from "./fixtures"
import { matcherForPlatform } from "./matcherForPlatform"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn() }
})

describe("approval with a drive-relative Windows workspace", () => {
	matcherForPlatform("win32")

	beforeEach(() => {
		vi.mocked(fs.realpath).mockReset().mockResolvedValue("C:/repo")
	})

	it.each(["readFile", "newFileCreated"] as const)(
		"does not approve %s outside the actual workspace through relative grants",
		async (tool) => {
			const { checkAutoApproval } = await import("../index")
			const state = { ...baseState, allowedReadFiles: ["docs/**"], allowedWriteFiles: ["docs/**"] }
			for (const path of ["C:/docs/private.md", "../docs/private.md"]) {
				expect(
					await checkAutoApproval({
						state,
						cwd: "C:",
						ask: "tool",
						text: JSON.stringify({ tool, path, isOutsideWorkspace: true }),
					}),
				).toEqual({ decision: "ask" })
			}

			const text = JSON.stringify({ tool, path: "C:/docs/private.md", isOutsideWorkspace: true })
			expect(
				await checkAutoApproval({
					state: { ...state, allowedReadFiles: ["C:/docs/**"], allowedWriteFiles: ["C:/docs/**"] },
					cwd: "C:",
					ask: "tool",
					text,
				}),
			).toEqual({ decision: "approve" })
			expect(
				await checkAutoApproval({
					state: {
						...state,
						allowedReadFiles: ["C:/docs/**", "!C:/docs/private.md"],
						allowedWriteFiles: ["C:/docs/**", "!C:/docs/private.md"],
					},
					cwd: "C:",
					ask: "tool",
					text,
				}),
			).toEqual({ decision: "ask" })
		},
	)
})
