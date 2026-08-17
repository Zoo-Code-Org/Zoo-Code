// npx vitest run core/auto-approval/__tests__/allowedReadFiles.spec.ts

import type { ExtensionState } from "@roo-code/types"

import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from ".."

const CWD = "/path/to/repo"

type State = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

const baseState: State = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: false,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	allowedReadFiles: [],
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

const askToRead = async ({
	state,
	tool = "readFile",
	...payload
}: {
	state: Partial<State>
	tool?: string
	path?: string
	batchFiles?: Array<{ path: string }>
	isOutsideWorkspace?: boolean
}) =>
	checkAutoApproval({
		state: { ...baseState, ...state },
		ask: "tool",
		text: JSON.stringify({ tool, ...payload }),
	})

describe("allowedReadFiles auto-approval", () => {
	it("asks when the file is not listed", async () => {
		expect(await askToRead({ path: "src/index.ts", state: { allowedReadFiles: ["notes.md"] } })).toEqual({
			decision: "ask",
		})
	})

	it("approves a listed file even though alwaysAllowReadOnly is off", async () => {
		expect(await askToRead({ path: "notes.md", state: { allowedReadFiles: ["notes.md"] } })).toEqual({
			decision: "approve",
		})
	})

	it("approves a listed file outside the workspace without the outside-workspace toggle", async () => {
		expect(
			await askToRead({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { allowedReadFiles: ["/tmp/notes.md"] },
			}),
		).toEqual({ decision: "approve" })
	})

	it("approves a file covered by a glob", async () => {
		expect(await askToRead({ path: "docs/scratch/a.md", state: { allowedReadFiles: ["docs/scratch/**"] } })).toEqual(
			{ decision: "approve" },
		)
	})

	// Write permission implies read permission.
	it("approves a file listed only in the write allowlist", async () => {
		expect(await askToRead({ path: "notes.md", state: { allowedWriteFiles: ["notes.md"] } })).toEqual({
			decision: "approve",
		})
	})

	it("does not grant write permission for a read-listed file", async () => {
		expect(
			await checkAutoApproval({
				state: { ...baseState, allowedReadFiles: ["notes.md"] },
				ask: "tool",
				text: JSON.stringify({ tool: "newFileCreated", path: "notes.md" }),
			}),
		).toEqual({ decision: "ask" })
	})

	describe("batch reads", () => {
		it("approves when every file in the batch is listed", async () => {
			expect(
				await askToRead({
					batchFiles: [{ path: "notes.md" }, { path: "todo.md" }],
					state: { allowedReadFiles: ["*.md"] },
				}),
			).toEqual({ decision: "approve" })
		})

		// One approval answers for the whole batch, so a single unlisted file
		// must not be carried in by its listed siblings.
		it("asks when only some files in the batch are listed", async () => {
			expect(
				await askToRead({
					batchFiles: [{ path: "notes.md" }, { path: "src/index.ts" }],
					state: { allowedReadFiles: ["notes.md"] },
				}),
			).toEqual({ decision: "ask" })
		})

		it("draws on both allowlists across a batch", async () => {
			expect(
				await askToRead({
					batchFiles: [{ path: "notes.md" }, { path: "todo.md" }],
					state: { allowedReadFiles: ["notes.md"], allowedWriteFiles: ["todo.md"] },
				}),
			).toEqual({ decision: "approve" })
		})
	})

	// The allowlist names files, but these tools act on directories and report
	// on files no pattern named, so a pattern must not approve them.
	describe("tools that are not file reads", () => {
		it.each(["listFiles", "listFilesTopLevel", "listFilesRecursive", "searchFiles", "codebaseSearch"])(
			"asks for %s even when the path is listed",
			async (tool) => {
				expect(
					await askToRead({
						tool,
						path: "docs",
						state: { allowedReadFiles: ["docs", "docs/**", "**"] },
					}),
				).toEqual({ decision: "ask" })
			},
		)

		it("still approves those tools when alwaysAllowReadOnly is on", async () => {
			expect(await askToRead({ tool: "listFiles", path: "docs", state: { alwaysAllowReadOnly: true } })).toEqual({
				decision: "approve",
			})
		})
	})

	it("asks when auto-approval is disabled entirely", async () => {
		expect(
			await askToRead({
				path: "notes.md",
				state: { allowedReadFiles: ["notes.md"], autoApprovalEnabled: false },
			}),
		).toEqual({ decision: "ask" })
	})

	it("leaves the alwaysAllowReadOnly behaviour unchanged when nothing is listed", async () => {
		expect(await askToRead({ path: "src/index.ts", state: { alwaysAllowReadOnly: true } })).toEqual({
			decision: "approve",
		})

		expect(
			await askToRead({
				path: "/tmp/notes.md",
				isOutsideWorkspace: true,
				state: { alwaysAllowReadOnly: true },
			}),
		).toEqual({ decision: "ask" })
	})
})
