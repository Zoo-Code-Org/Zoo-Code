// npx vitest run core/auto-approval/__tests__/allowedReadFiles.spec.ts

import { checkAutoApproval } from ".."
import { CWD, baseState, type State } from "./fixtures"

const askToRead = async ({
	state,
	tool = "readFile",
	cwd = CWD,
	...payload
}: {
	state: Partial<State>
	tool?: string
	cwd?: string
	path?: string
	batchFiles?: Array<{ path: string }>
	batchDirs?: Array<{ path: string }>
	additionalFileCount?: number
	isOutsideWorkspace?: boolean
}) =>
	checkAutoApproval({
		state: { ...baseState, ...state },
		cwd,
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
		expect(
			await askToRead({ path: "docs/scratch/a.md", state: { allowedReadFiles: ["docs/scratch/**"] } }),
		).toEqual({ decision: "approve" })
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
				cwd: CWD,
				ask: "tool",
				text: JSON.stringify({ tool: "newFileCreated", path: "notes.md" }),
			}),
		).toEqual({ decision: "ask" })
	})

	// The patterns and the path have to be resolved against the same root, which is
	// the one the task runs in rather than the one the window currently shows.
	it("resolves the patterns against the cwd it is given", async () => {
		const state = { allowedReadFiles: ["/path/to/repo/notes.md"] }

		expect(await askToRead({ path: "notes.md", cwd: "/path/to/repo", state })).toEqual({
			decision: "approve",
		})

		expect(await askToRead({ path: "notes.md", cwd: "/path/to/other-repo", state })).toEqual({
			decision: "ask",
		})
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

		it("does not let a listed batch carry an unlisted path", async () => {
			expect(
				await askToRead({
					path: "src/index.ts",
					batchFiles: [{ path: "notes.md" }],
					state: { allowedReadFiles: ["notes.md"] },
				}),
			).toEqual({ decision: "ask" })
		})

		it("asks when the read names no file at all", async () => {
			expect(await askToRead({ state: { allowedReadFiles: ["*", "**", "notes.md"] } })).toEqual({
				decision: "ask",
			})
		})

		// `additionalFileCount` reports files the message does not name, and the
		// approval would cover them as well, so no pattern can vouch for them.
		it("asks when the read carries files it does not name", async () => {
			expect(
				await askToRead({
					path: "notes.md",
					additionalFileCount: 2,
					state: { allowedReadFiles: ["notes.md"] },
				}),
			).toEqual({ decision: "ask" })

			expect(
				await askToRead({
					batchFiles: [{ path: "notes.md" }],
					additionalFileCount: 1,
					state: { allowedReadFiles: ["*.md"] },
				}),
			).toEqual({ decision: "ask" })
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

		// Listing tools report their directories in `batchDirs`. They are turned away
		// by the tool name, but assert it here as well so the two reasons cannot both
		// disappear unnoticed.
		it("asks for a directory listing batch even when the directories are listed", async () => {
			expect(
				await askToRead({
					tool: "listFilesTopLevel",
					batchDirs: [{ path: "docs" }, { path: "src" }],
					state: { allowedReadFiles: ["docs", "src", "**"] },
				}),
			).toEqual({ decision: "ask" })
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
