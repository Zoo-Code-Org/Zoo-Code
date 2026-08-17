// npx vitest run core/auto-approval/__tests__/allowedWriteFiles.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from ".."

const CWD = "/path/to/repo"

type State = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

const baseState: State = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: false,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	allowedWriteFiles: [],
	cwd: CWD,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowExecute: false,
	alwaysAllowFollowupQuestions: false,
	destructiveCommandGuardEnabled: false,
	allowedCommands: [],
	deniedCommands: [],
}

const askToWrite = async ({
	path,
	state,
	tool = "newFileCreated",
	isProtected,
	isOutsideWorkspace,
}: {
	path: string
	state: Partial<State>
	tool?: string
	isProtected?: boolean
	isOutsideWorkspace?: boolean
}) =>
	checkAutoApproval({
		state: { ...baseState, ...state },
		ask: "tool",
		text: JSON.stringify({ tool, path, isOutsideWorkspace, isProtected }),
		isProtected,
	})

describe("allowedWriteFiles auto-approval", () => {
	it("asks when the file is not listed", async () => {
		expect(await askToWrite({ path: "src/index.ts", state: { allowedWriteFiles: ["notes.md"] } })).toEqual({
			decision: "ask",
		})
	})

	it("approves a listed file even though alwaysAllowWrite is off", async () => {
		expect(await askToWrite({ path: "notes.md", state: { allowedWriteFiles: ["notes.md"] } })).toEqual({
			decision: "approve",
		})
	})

	it("approves each write tool action for a listed file", async () => {
		for (const tool of ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"]) {
			expect(await askToWrite({ path: "notes.md", state: { allowedWriteFiles: ["notes.md"] }, tool })).toEqual({
				decision: "approve",
			})
		}
	})

	it("approves a listed file outside the workspace without the outside-workspace toggle", async () => {
		expect(
			await askToWrite({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { allowedWriteFiles: ["/tmp/notes.md"] },
			}),
		).toEqual({ decision: "approve" })
	})

	it("still asks for a protected file, even when listed", async () => {
		expect(
			await askToWrite({
				path: "AGENTS.md",
				isProtected: true,
				state: { allowedWriteFiles: ["*.md"] },
			}),
		).toEqual({ decision: "ask" })
	})

	it("approves a listed protected file once protected writes are allowed", async () => {
		expect(
			await askToWrite({
				path: "AGENTS.md",
				isProtected: true,
				state: { allowedWriteFiles: ["*.md"], alwaysAllowWriteProtected: true },
			}),
		).toEqual({ decision: "approve" })
	})

	// Write permission implies read permission.
	it("grants read permission for a listed file", async () => {
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedWriteFiles: ["notes.md"] },
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "notes.md" }),
			}),
		).toEqual({ decision: "approve" })
	})

	it("does not grant read permission for an unlisted file", async () => {
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedWriteFiles: ["notes.md"] },
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "src/index.ts" }),
			}),
		).toEqual({ decision: "ask" })
	})

	it("asks when auto-approval is disabled entirely", async () => {
		expect(
			await askToWrite({
				path: "notes.md",
				state: { allowedWriteFiles: ["notes.md"], autoApprovalEnabled: false },
			}),
		).toEqual({ decision: "ask" })
	})

	it("leaves the alwaysAllowWrite behaviour unchanged when nothing is listed", async () => {
		expect(await askToWrite({ path: "src/index.ts", state: { alwaysAllowWrite: true } })).toEqual({
			decision: "approve",
		})

		expect(
			await askToWrite({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { alwaysAllowWrite: true },
			}),
		).toEqual({ decision: "ask" })
	})
})
