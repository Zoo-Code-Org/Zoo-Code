import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { Mock } from "vitest"
import { providerIdentifiers } from "@roo-code/types"

import {
	buildCommitMessagePrompt,
	cleanCommitMessage,
	COMMIT_MESSAGE_SYSTEM_PROMPT,
	commitMessageRequestStateSize,
	DIFF_CHARACTER_LIMIT,
	DIFF_LINE_LIMIT,
	DIFF_TRUNCATED_MESSAGE,
	DRAFT_CHANGED_MESSAGE,
	generateCommitMessage,
	getGitApi,
	getRepositoryDiff,
	IGNORED_FILE_NOTE,
	NO_CHANGES_MESSAGE,
	omitIgnoredFiles,
	ROOIGNORE_UNREADABLE_MESSAGE,
	resetCommitMessageRequestState,
	resolveGitRepository,
	PREVIOUS_REQUEST_WAIT_MS,
	WAITING_FOR_PREVIOUS_REQUEST_MESSAGE,
	PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE,
	type GitAPI,
	type GitRepository,
} from "../commitMessageGenerator"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { makeUri } from "../../../test-utils/vscode"

// RooIgnoreController watches `.rooignore`. The watcher double provides the three events and dispose.
const { watcherDispose, makeWatcher } = vi.hoisted(() => {
	const watcherDispose = vi.fn()
	const makeWatcher = () => ({
		onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
		onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
		dispose: watcherDispose,
	})
	return { watcherDispose, makeWatcher }
})

vi.mock("vscode", () => ({
	ProgressLocation: {
		Notification: 15,
	},
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
	workspace: {
		createFileSystemWatcher: vi.fn(makeWatcher),
	},
	extensions: {
		getExtension: vi.fn(),
	},
	window: {
		activeTextEditor: undefined,
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		withProgress: vi.fn(),
	},
	Uri: {
		file: (path: string) => makeUri(path),
		parse: (uri: string) => makeUri(uri),
	},
}))

vi.mock("../../../utils/single-completion-handler", () => ({
	singleCompletionHandler: vi.fn(),
}))

function makeRepo(root: string, overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		rootUri: makeUri(root),
		inputBox: { value: "" },
		diff: vi.fn().mockResolvedValue("diff content"),
		...overrides,
	}
}

/** Makes `repository` the only repository of the Git API that the generator reads. */
function useOnlyRepository(repository: GitRepository): void {
	const gitApi: GitAPI = { repositories: [repository] }
	;(vscode.extensions.getExtension as Mock).mockReturnValue({ isActive: true, exports: { getAPI: () => gitApi } })
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/**
 * Installs a withProgress mock whose token can be cancelled from the test. Every registered
 * cancellation listener runs on cancel(), like a real vscode.CancellationTokenSource.
 */
function useCancellableProgress({ once = false }: { once?: boolean } = {}) {
	let cancelled = false
	const listeners: Array<() => void> = []
	const disposable = { dispose: vi.fn() }
	const withProgress = vscode.window.withProgress as Mock
	// With `once`, only the next withProgress call gets this token; later calls use the default mock.
	const install = once
		? withProgress.mockImplementationOnce.bind(withProgress)
		: withProgress.mockImplementation.bind(withProgress)
	install((_opts: unknown, callback: (progress: unknown, token: unknown) => unknown) => {
		const token = {
			get isCancellationRequested() {
				return cancelled
			},
			onCancellationRequested: vi.fn((fn: () => void) => {
				listeners.push(fn)
				return disposable
			}),
		}
		return callback({ report: vi.fn() }, token)
	})
	return {
		disposable,
		cancel: () => {
			cancelled = true
			listeners.forEach((fn) => fn())
		},
	}
}

describe("commitMessageGenerator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetCommitMessageRequestState()
		;(vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined
	})

	describe("cleanCommitMessage", () => {
		it("removes markdown code fences and backticks", () => {
			const input = "```markdown\nfeat(auth): add login flow\n```"
			expect(cleanCommitMessage(input)).toBe("feat(auth): add login flow")
		})

		it("removes surrounding quotes", () => {
			expect(cleanCommitMessage('"feat: simple commit"')).toBe("feat: simple commit")
			expect(cleanCommitMessage("'feat: simple commit'")).toBe("feat: simple commit")
		})

		it("trims whitespace", () => {
			expect(cleanCommitMessage("  fix: bug  \n")).toBe("fix: bug")
		})
	})

	describe("buildCommitMessagePrompt", () => {
		it("includes diff and instructions", () => {
			const { prompt, truncated } = buildCommitMessagePrompt("diff --git a/file b/file\n+test")
			expect(prompt).toContain("diff --git a/file b/file\n+test")
			expect(prompt).toContain("Conventional Commits")
			expect(truncated).toBe(false)
		})

		it.each([
			["character", "x".repeat(DIFF_CHARACTER_LIMIT + 1)],
			["line", Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `+line ${i}`).join("\n")],
		])("reports truncation when the diff exceeds the %s limit", (_label, diff) => {
			const { prompt, truncated } = buildCommitMessagePrompt(diff)
			expect(truncated).toBe(true)
			expect(prompt).toContain(COMMIT_MESSAGE_SYSTEM_PROMPT)
			expect(prompt).toMatch(/\[\.\.\.\d+ (?:characters|lines) omitted\.\.\.\]/)
		})

		it("does not report truncation at exactly the character limit", () => {
			const { truncated } = buildCommitMessagePrompt("x".repeat(DIFF_CHARACTER_LIMIT))
			expect(truncated).toBe(false)
		})
	})

	describe("omitIgnoredFiles", () => {
		const blocked = new Set([".env", "keys/a b.pem", "conf/.env.pröd", 'conf/a"b.env', "conf/a\tb.env"])
		const isAllowed = (relativePath: string) => !blocked.has(relativePath)
		const section = (header: string, ...rest: string[]) => [header, ...rest].join("\n")
		const app = section("diff --git a/app.ts b/app.ts", "--- a/app.ts", "+++ b/app.ts", "@@ -1 +1 @@", "+x = 1")

		it.each([
			["a changed file", section("diff --git a/.env b/.env", "--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "+A=1")],
			[
				"an added file",
				section("diff --git a/.env b/.env", "--- /dev/null", "+++ b/.env", "@@ -0,0 +1 @@", "+A=1"),
			],
			[
				"a deleted file",
				section("diff --git a/.env b/.env", "--- a/.env", "+++ /dev/null", "@@ -1 +0,0 @@", "-A=1"),
			],
			[
				"a file renamed from a blocked path",
				section(
					"diff --git a/.env b/x",
					"rename from .env",
					"rename to x",
					"--- a/.env",
					"+++ b/x",
					"@@ -1 +1 @@",
					"-A=1",
				),
			],
			[
				"a pure rename",
				section("diff --git a/x b/.env", "similarity index 100%", "rename from x", "rename to .env"),
			],
			["a copy", section("diff --git a/.env b/y", "copy from .env", "copy to y")],
			[
				"a path with a space (Git adds a tab)",
				section(
					"diff --git a/keys/a b.pem b/keys/a b.pem",
					"--- a/keys/a b.pem\t",
					"+++ b/keys/a b.pem\t",
					"@@ -1 +1 @@",
					"+k",
				),
			],
			[
				"a quoted path with octal escapes",
				section(
					'diff --git "a/conf/.env.pr\\303\\266d" "b/conf/.env.pr\\303\\266d"',
					'--- "a/conf/.env.pr\\303\\266d"',
					'+++ "b/conf/.env.pr\\303\\266d"',
					"@@ -1 +1 @@",
					"+A=1",
				),
			],
			[
				"a quoted path with an escaped quote",
				section(
					'diff --git "a/conf/a\\"b.env" "b/conf/a\\"b.env"',
					'--- "a/conf/a\\"b.env"',
					'+++ "b/conf/a\\"b.env"',
					"@@ -1 +1 @@",
					"+A=1",
				),
			],
			[
				"a quoted path with a C escape",
				section(
					'diff --git "a/conf/a\\tb.env" "b/conf/a\\tb.env"',
					'--- "a/conf/a\\tb.env"',
					'+++ "b/conf/a\\tb.env"',
					"@@ -1 +1 @@",
					"+A=1",
				),
			],
			[
				"custom prefixes (diff.srcPrefix and diff.dstPrefix)",
				section("diff --git old/.env new/.env", "--- old/.env", "+++ new/.env", "@@ -1 +1 @@", "+A=1"),
			],
			[
				"custom prefixes with more than one folder",
				section("diff --git x/old/.env y/new/.env", "--- x/old/.env", "+++ y/new/.env", "@@ -1 +1 @@", "+A=1"),
			],
			[
				"mnemonic prefixes",
				section("diff --git i/.env w/.env", "--- i/.env", "+++ w/.env", "@@ -1 +1 @@", "+A=1"),
			],
			["no prefixes", section("diff --git .env .env", "--- .env", "+++ .env", "@@ -1 +1 @@", "+A=1")],
			[
				"a CRLF diff",
				section("diff --git a/.env b/.env\r", "--- a/.env\r", "+++ b/.env\r", "@@ -1 +1 @@\r", "+A=1\r"),
			],
			[
				"a combined diff of a merge conflict",
				section(
					"diff --cc .env",
					"index 1,2..3",
					"--- a/.env",
					"+++ b/.env",
					"@@@ -1,1 -1,1 +1,1 @@@",
					"++A=1",
				),
			],
		])("leaves out the content of %s and keeps its first line", (_label, ignored) => {
			const [header = ""] = ignored.split("\n")
			expect(omitIgnoredFiles(`${app}\n${ignored}\n${app}`, isAllowed)).toBe(
				`${app}\n${header}\n${IGNORED_FILE_NOTE}\n${app}`,
			)
		})

		it.each([
			["a diff without blocked files", app],
			// The removed line `-- a/.env` and the added line `++ b/.env` look like path lines.
			["a file whose content has path lines after its first hunk", section(app, "--- a/.env", "+++ b/.env")],
			["the list of untracked files", "Untracked files:\n.env\nsrc/app.ts"],
			["an empty diff", ""],
			[
				"a file with more lines than a call can take as arguments",
				`${app}\n${Array<string>(200_000).fill("+x").join("\n")}`,
			],
		])("keeps %s unchanged", (_label, diff) => {
			expect(omitIgnoredFiles(diff, isAllowed)).toBe(diff)
		})

		it("leaves out a file with custom prefixes without a slash when the Git extension lists it", () => {
			const ignored = section(
				"diff --git old-.env new-.env",
				"--- old-.env",
				"+++ new-.env",
				"@@ -1 +1 @@",
				"+A=1",
			)
			expect(omitIgnoredFiles(ignored, isAllowed, new Set([".env"]))).toBe(
				`diff --git old-.env new-.env\n${IGNORED_FILE_NOTE}`,
			)
		})

		it.each([
			["a changed file", ["--- a/src/x", "+++ b/src/y"], ["a/src/x", "src/x", "x", "b/src/y", "src/y", "y"]],
			["an added file", ["--- /dev/null", "+++ b/y"], ["b/y", "y"]],
			[
				"a file with custom prefixes",
				["--- old-src/x", "+++ new-src/x"],
				["old-src/x", "x", "src/x", "new-src/x"],
			],
		])("checks each path of %s once, by folder and by listed path", (_label, pathLines, expected) => {
			const checked: string[] = []
			const diff = section("diff --git a/x b/y", ...pathLines, "@@ -0,0 +1 @@", "--- a/z")
			omitIgnoredFiles(
				diff,
				(relativePath) => {
					checked.push(relativePath)
					return true
				},
				new Set(["src/x"]),
			)
			expect(checked).toEqual(expected)
		})

		it("checks a bounded number of paths for a diff of many files", () => {
			const files = Array.from({ length: 500 }, (_, i) => `src/feature/file${i}.ts`)
			const diff = files
				.map((file) =>
					section(`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "+x"),
				)
				.join("\n")
			let checks = 0
			omitIgnoredFiles(
				diff,
				() => {
					checks++
					return true
				},
				new Set(files),
			)
			// Each file: a/src/feature/fileN.ts and b/..., then src/feature/fileN.ts, feature/fileN.ts, fileN.ts.
			expect(checks).toBe(files.length * 5)
		})
	})

	describe("getGitApi", () => {
		it("returns undefined if git extension not found", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue(undefined)
			const api = await getGitApi()
			expect(api).toBeUndefined()
		})

		it("activates git extension if not active and returns API", async () => {
			const mockApi = { repositories: [] }
			const mockExt = {
				isActive: false,
				activate: vi.fn().mockResolvedValue(undefined),
				exports: {
					getAPI: vi.fn().mockReturnValue(mockApi),
				},
			}
			;(vscode.extensions.getExtension as Mock).mockReturnValue(mockExt)

			const api = await getGitApi()
			expect(mockExt.activate).toHaveBeenCalled()
			expect(mockExt.exports.getAPI).toHaveBeenCalledWith(1)
			expect(api).toBe(mockApi)
		})
	})

	describe("resolveGitRepository", () => {
		it("returns undefined if repositories list is empty", () => {
			const git: GitAPI = { repositories: [] }
			expect(resolveGitRepository(git)).toBeUndefined()
		})

		it("resolves from repository object context directly", () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo] }

			expect(resolveGitRepository(git, repo)).toBe(repo)
		})

		it("resolves a SourceControl context from the scm/title menu by rootUri", () => {
			const repo1 = makeRepo("/workspace/repo1")
			const repo2 = makeRepo("/workspace/repo2")
			const git: GitAPI = { repositories: [repo1, repo2] }
			const sourceControl = { id: "git", rootUri: makeUri("/workspace/repo2"), inputBox: { value: "" } }

			expect(resolveGitRepository(git, sourceControl)).toBe(repo2)
		})

		it("rejects a repository-shaped context that is not a known repository", () => {
			const known = makeRepo("/workspace/repo1")
			const other = makeRepo("/workspace/repo2")
			const git: GitAPI = { repositories: [known, other] }
			const fake = makeRepo("/workspace/attacker")

			expect(resolveGitRepository(git, fake)).toBeUndefined()
			expect(fake.diff).not.toHaveBeenCalled()
		})

		it("returns the known repository, not the context object, when a fake context reuses its rootUri", () => {
			const known = makeRepo("/workspace/repo")
			const git: GitAPI = { repositories: [known, makeRepo("/workspace/other")] }
			const fake = makeRepo("/workspace/repo")

			const resolved = resolveGitRepository(git, fake)
			expect(resolved).toBe(known)
			expect(resolved).not.toBe(fake)
		})

		it.each([
			["a bare Uri", (root: vscode.Uri) => root],
			["a SourceControl rootUri", (root: vscode.Uri) => ({ rootUri: root })],
		])("matches %s by its scheme and fsPath without calling its methods", (_label, wrap) => {
			const known = makeRepo("/workspace/repo")
			const git: GitAPI = { repositories: [makeRepo("/workspace/other"), known] }
			const forgedToString = vi.fn(() => "/workspace/repo")
			const forged = { scheme: "file", fsPath: "/workspace/repo", toString: forgedToString }

			expect(resolveGitRepository(git, wrap(forged as unknown as vscode.Uri))).toBe(known)
			expect(forgedToString).not.toHaveBeenCalled()
		})

		it.each([
			["a different fsPath", { scheme: "file", fsPath: "/workspace/attacker" }],
			["a different scheme", { scheme: "untitled", fsPath: "/workspace/repo" }],
		])("rejects a forged Uri with %s even when its toString matches", (_label, fields) => {
			const git: GitAPI = { repositories: [makeRepo("/workspace/repo"), makeRepo("/workspace/other")] }
			const forgedToString = vi.fn(() => "/workspace/repo")

			expect(resolveGitRepository(git, { ...fields, toString: forgedToString })).toBeUndefined()
			expect(forgedToString).not.toHaveBeenCalled()
		})

		it("rejects a fake context with a matching-looking inputBox", () => {
			const git: GitAPI = { repositories: [makeRepo("/workspace/repo1"), makeRepo("/workspace/repo2")] }
			const fake = { inputBox: { value: "" }, diff: vi.fn() }

			expect(resolveGitRepository(git, fake)).toBeUndefined()
			expect(fake.diff).not.toHaveBeenCalled()
		})

		it("resolves from bare vscode.Uri context", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, makeUri("/workspace/repo2"))).toBe(repo2)
		})

		it("resolves from scm context with rootUri", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { rootUri: makeUri("/workspace/repo2") })).toBe(repo2)
		})

		it("resolves from scm context with inputBox", () => {
			const inputBox1 = { value: "" }
			const inputBox2 = { value: "" }
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: inputBox1,
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: inputBox2,
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { inputBox: inputBox2 })).toBe(repo2)
		})

		it("falls back to first repository when only one exists", () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo] }

			expect(resolveGitRepository(git)).toBe(repo)
		})

		it("matches active editor URI if multiple repositories exist", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/repo2/src/file.ts"),
				},
			} as unknown as vscode.TextEditor // Structural test double providing document.uri

			expect(resolveGitRepository(git)).toBe(repo2)
		})

		it("returns undefined if bare vscode.Uri context does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, makeUri("/workspace/unknown"))).toBeUndefined()
		})

		it("returns undefined if scm context rootUri does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { rootUri: makeUri("/workspace/unknown") })).toBeUndefined()
		})

		it("returns undefined if scm context inputBox does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { inputBox: { value: "other" } })).toBeUndefined()
		})

		it("falls back to first repository when active editor does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/other/file.ts"),
				},
			} as unknown as vscode.TextEditor // Structural test double providing document.uri

			expect(resolveGitRepository(git)).toBe(repo1)
		})

		it("distinguishes repository roots on path segment boundaries", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo-other"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/repo-other/file.ts"),
				},
			} as unknown as vscode.TextEditor

			expect(resolveGitRepository(git)).toBe(repo2)
		})

		it("matches longest root when repositories are nested", () => {
			const parentRepo: GitRepository = {
				rootUri: makeUri("/workspace/monorepo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const childRepo: GitRepository = {
				rootUri: makeUri("/workspace/monorepo/packages/nested"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [parentRepo, childRepo] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/monorepo/packages/nested/src/index.ts"),
				},
			} as unknown as vscode.TextEditor

			expect(resolveGitRepository(git)).toBe(childRepo)
		})
	})

	describe("getRepositoryDiff", () => {
		it("prioritizes staged diff", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("staged diff")
					return Promise.resolve("working diff")
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBe("staged diff")
			expect(repo.diff).toHaveBeenCalledWith(true)
		})

		it("falls back to working tree diff if staged diff is empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("")
					return Promise.resolve("working diff")
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBe("working diff")
			expect(repo.diff).toHaveBeenCalledWith(true)
			expect(repo.diff).toHaveBeenCalledWith(false)
		})

		it.each([
			["the working tree", 1],
			["untracked files", 2],
		])("does not read %s after the signal aborts", async (_label, abortAfterCall) => {
			// The signal aborts while the Git read with this call number is pending.
			const controller = new AbortController()
			const diff = vi.fn().mockImplementation(async () => {
				if (diff.mock.calls.length === abortAfterCall) {
					controller.abort()
				}
				return ""
			})
			const workingTreeChanges = vi.fn(() => [{ uri: makeUri("/workspace/repo/new.ts"), status: 7 }])
			const repo = makeRepo("/workspace/repo", {
				diff,
				state: {
					get workingTreeChanges() {
						return workingTreeChanges()
					},
				},
			})

			await expect(getRepositoryDiff(repo, controller.signal)).resolves.toBeUndefined()
			expect(diff).toHaveBeenCalledTimes(abortAfterCall)
			expect(workingTreeChanges).not.toHaveBeenCalled()
		})

		it("rejects without reading the working tree when the staged diff fails", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.reject(new Error("Git diff staged failed"))
					return Promise.resolve("working diff fallback")
				}),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("Git diff staged failed")
			expect(repo.diff).not.toHaveBeenCalledWith(false)
		})

		it("rejects with the staged error when both staged and working tree diffs fail", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi
					.fn()
					.mockImplementation((cached?: boolean) =>
						Promise.reject(new Error(cached ? "staged failed" : "working failed")),
					),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("staged failed")
		})

		it("returns undefined if both staged and working diffs are empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBeUndefined()
		})

		it("rejects if working diff fails after empty staged diff", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("")
					return Promise.reject(new Error("Git working tree diff failed"))
				}),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("Git working tree diff failed")
		})

		it("lists untracked files relative to the repository root", async () => {
			const repo = makeRepo("/home/alice/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [{ uri: makeUri("/home/alice/workspace/repo/src/new-file.ts"), status: 7 }],
				},
			})

			const diff = await getRepositoryDiff(repo)
			// path.relative uses the platform separator.
			expect(diff).toMatch(/^Untracked files:\nsrc[\\/]new-file\.ts$/)
		})

		it("lists untracked files from the separate untrackedChanges group", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [],
					untrackedChanges: [{ uri: makeUri("/workspace/repo/brand-new.ts"), status: 7 }],
				},
			})

			expect(await getRepositoryDiff(repo)).toBe("Untracked files:\nbrand-new.ts")
		})

		it("de-duplicates a file listed in both untracked locations", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/a.ts"), status: 7 },
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 },
					],
					untrackedChanges: [
						{ uri: makeUri("/workspace/repo/a.ts"), status: 7 },
						{ uri: makeUri("/workspace/repo/b.ts"), status: 7 },
					],
				},
			})

			expect(await getRepositoryDiff(repo)).toBe("Untracked files:\na.ts\nb.ts")
		})

		it("returns undefined when both untracked locations are empty", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: { workingTreeChanges: [], untrackedChanges: [] },
			})

			expect(await getRepositoryDiff(repo)).toBeUndefined()
		})

		it("surfaces untracked files when both diffs are empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/new-file.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toContain("Untracked files:")
			expect(diff).toContain("new-file.ts")
			expect(diff).not.toContain("modified.ts")
		})

		it("surfaces all untracked files when mixed with tracked changes", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/new-a.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/new-b.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED (not untracked)
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toContain("Untracked files:")
			expect(diff).toContain("new-a.ts")
			expect(diff).toContain("new-b.ts")
			expect(diff).not.toContain("modified.ts")
		})

		it("returns undefined when both diffs are empty and no untracked files exist", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED (not untracked)
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBeUndefined()
		})
	})

	describe("generateCommitMessage", () => {
		let mockProvider: ClineProvider
		let mockOutputChannel: vscode.OutputChannel
		let mockRepo: GitRepository

		beforeEach(() => {
			mockOutputChannel = {
				appendLine: vi.fn(),
				append: vi.fn(),
				clear: vi.fn(),
				hide: vi.fn(),
				name: "test",
				replace: vi.fn(),
				show: vi.fn(),
				dispose: vi.fn(),
			}

			mockRepo = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue("diff content"),
			}

			// Structural test double providing getState for generateCommitMessage
			mockProvider = {
				getState: vi.fn().mockResolvedValue({
					apiConfiguration: {
						apiProvider: providerIdentifiers.anthropic,
						apiKey: "test-key",
					},
				}),
			} as unknown as ClineProvider

			const mockGitApi: GitAPI = {
				repositories: [mockRepo],
			}
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => mockGitApi,
				},
			})

			// Default withProgress mock: runs the callback immediately with a non-cancelled token.
			// Individual tests may override this for cancellation or error scenarios.
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})
		})

		it("shows error if git extension is unavailable", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue(undefined)

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Git extension not found or not enabled.")
		})

		it("shows error if no git repository found", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => ({ repositories: [] }),
				},
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Git repository found.")
		})

		it("shows info if no diff is found", async () => {
			mockRepo.diff = vi.fn().mockResolvedValue("")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(NO_CHANGES_MESSAGE)
		})

		it("reports a Git diff failure as an error instead of 'no changes'", async () => {
			mockRepo.diff = vi.fn().mockRejectedValue(new Error("fatal: bad index file"))

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(NO_CHANGES_MESSAGE)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: fatal: bad index file",
			)
			expect(singleCompletionHandler).not.toHaveBeenCalled()
		})

		it("never reads from or writes to a command context that is not a known repository", async () => {
			const fake = makeRepo("/workspace/attacker")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
				context: fake,
			})

			expect(fake.diff).not.toHaveBeenCalled()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(fake.inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Git repository found.")
		})

		it("generates for the repository named by an scm/title SourceControl context", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("fix: second repo")
			const second = makeRepo("/workspace/second")
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: { getAPI: () => ({ repositories: [mockRepo, second] }) },
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
				context: { rootUri: makeUri("/workspace/second"), inputBox: { value: "" } },
			})

			expect(second.inputBox.value).toBe("fix: second repo")
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("warns after writing when the diff was truncated", async () => {
			mockRepo.diff = vi.fn().mockResolvedValue("x".repeat(DIFF_CHARACTER_LIMIT + 1))
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: large change")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: large change")
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(DIFF_TRUNCATED_MESSAGE)
		})

		it("does not warn about truncation for a diff within the limits", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: small change")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: small change")
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		})

		it("keeps text the user typed while the request was pending", async () => {
			mockRepo.inputBox.value = "draft"
			;(singleCompletionHandler as Mock).mockImplementation(async () => {
				mockRepo.inputBox.value = "typed by user"
				return "feat: generated"
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("typed by user")
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("replaces an unchanged draft with the generated message", async () => {
			mockRepo.inputBox.value = "draft"
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: generated")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: generated")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("aborts an older request for the same repository and sends the newer one after it settles", async () => {
			const first = deferred<string>()
			let olderSignal: AbortSignal | undefined
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce((_config, _prompt, options: { abortSignal: AbortSignal }) => {
					olderSignal = options.abortSignal
					// This provider ignores the abort signal and settles later.
					return first.promise
				})
				.mockResolvedValueOnce("feat: newer")

			const older = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const newer = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await older
			expect(olderSignal?.aborted).toBe(true)

			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			await new Promise((resolve) => setTimeout(resolve, 0))
			// No second provider request while the older one still runs.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			first.resolve("feat: older")
			await newer

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: newer")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("treats new Git API wrappers for one repository as the same repository", async () => {
			// The VS Code Git API creates a new repository wrapper on each read of `repositories`.
			// The wrappers share one underlying input box.
			const sharedInputBox = { value: "" }
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => ({
						get repositories() {
							return [makeRepo("/workspace/repo", { inputBox: sharedInputBox })]
						},
					}),
				},
			})
			const first = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockResolvedValueOnce("feat: newer")

			const older = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const newer = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await older
			first.resolve("feat: older")
			await newer

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(sharedInputBox.value).toBe("feat: newer")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("never runs two provider requests for one repository, even with several waiting requests", async () => {
			const first = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockResolvedValueOnce("feat: latest")

			const a = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const b = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			const c = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(3))
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			first.resolve("feat: first")
			await Promise.all([a, b, c])

			// The middle request is no longer the newest after the wait, so it sends nothing.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: latest")
		})

		it("keeps the latest request of each repository independent", async () => {
			const otherRepo = makeRepo("/workspace/other")
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: { getAPI: () => ({ repositories: [mockRepo, otherRepo] }) },
			})
			const first = deferred<string>()
			const second = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise)

			const forMockRepo = generateCommitMessage({ provider: mockProvider, context: mockRepo })
			const forOtherRepo = generateCommitMessage({ provider: mockProvider, context: otherRepo })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(2))

			second.resolve("feat: other")
			await forOtherRepo
			first.resolve("feat: mock")
			await forMockRepo

			expect(mockRepo.inputBox.value).toBe("feat: mock")
			expect(otherRepo.inputBox.value).toBe("feat: other")
		})

		it("closes the progress immediately when cancelled while the LLM call is pending", async () => {
			const { cancel, disposable } = useCancellableProgress()
			let capturedSignal: AbortSignal | undefined
			// The provider ignores the abort signal and never settles.
			;(singleCompletionHandler as Mock).mockImplementation((_config, _prompt, options) => {
				capturedSignal = options.abortSignal as AbortSignal
				return new Promise(() => {})
			})

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run

			expect(capturedSignal?.aborted).toBe(true)
			expect(disposable.dispose).toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it.each([
			["a staged diff", true],
			["a working-tree diff", false],
		])("leaves files in .rooignore out of the prompt for %s", async (_label, staged) => {
			const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
			try {
				await writeFile(path.join(root, ".rooignore"), ".env\nconfig/private/\n")
				// The Git extension lists the changed files. It finds `.env` also behind custom prefixes.
				const changes = [".env", "config/private/keys.json", "src/app.ts"].map((file) => ({
					uri: vscode.Uri.file(path.join(root, file)),
					status: 5,
				}))
				mockRepo = makeRepo(root, { state: { indexChanges: changes, workingTreeChanges: changes } })
				useOnlyRepository(mockRepo)
				const diff = [
					"diff --git a/.env b/.env",
					"--- a/.env",
					"+++ b/.env",
					"@@ -1 +1 @@",
					"-DB=old",
					"+DB=hunter2",
					"diff --git a/config/private/keys.json b/config/private/keys.json",
					"new file mode 100644",
					"--- /dev/null",
					"+++ b/config/private/keys.json",
					"@@ -0,0 +1 @@",
					'+{"key":"hunter3"}',
					"diff --git a/src/app.ts b/src/app.ts",
					"--- a/src/app.ts",
					"+++ b/src/app.ts",
					"@@ -1 +1 @@",
					"+export const port = 8080",
					// With diff.srcPrefix=old- and diff.dstPrefix=new-
					"diff --git old-.env new-.env",
					"--- old-.env",
					"+++ new-.env",
					"@@ -1 +1 @@",
					"+SESSION=hunter4",
				].join("\n")
				mockRepo.diff = vi.fn((cached?: boolean) => Promise.resolve(cached === staged ? diff : ""))
				;(singleCompletionHandler as Mock).mockResolvedValue("chore: update config")

				await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

				const prompt = (singleCompletionHandler as Mock).mock.calls[0][1] as string
				expect(prompt).not.toContain("hunter2")
				expect(prompt).not.toContain("hunter3")
				expect(prompt).not.toContain("hunter4")
				expect(prompt).toContain(`diff --git a/.env b/.env\n${IGNORED_FILE_NOTE}`)
				expect(prompt).toContain(
					`diff --git a/config/private/keys.json b/config/private/keys.json\n${IGNORED_FILE_NOTE}`,
				)
				expect(prompt).toContain("+export const port = 8080")
				// The controller watches `.rooignore` only for this run.
				expect(watcherDispose).toHaveBeenCalledTimes(1)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		})

		it("stops before reading the provider settings when the user cancels while .rooignore is read", async () => {
			const { cancel } = useCancellableProgress()
			;(vscode.workspace.createFileSystemWatcher as Mock).mockImplementationOnce(() => {
				cancel()
				return makeWatcher()
			})

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(mockProvider.getState).not.toHaveBeenCalled()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
			await vi.waitFor(() => expect(watcherDispose).toHaveBeenCalledTimes(1))
		})

		it("stops without a provider request when .rooignore exists but cannot be read", async () => {
			const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
			try {
				// A folder named .rooignore exists, but reading it as a file fails.
				await mkdir(path.join(root, ".rooignore"))
				vi.spyOn(console, "error").mockImplementation(() => {})
				mockRepo = makeRepo(root)
				useOnlyRepository(mockRepo)
				mockRepo.diff = vi.fn().mockResolvedValue("diff --git a/.env b/.env\n@@ -1 +1 @@\n+DB=hunter2")

				await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

				expect(singleCompletionHandler).not.toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
					`Failed to generate commit message: ${ROOIGNORE_UNREADABLE_MESSAGE}`,
				)
				expect(mockRepo.inputBox.value).toBe("")
			} finally {
				vi.restoreAllMocks()
				await rm(root, { recursive: true, force: true })
			}
		})

		it("stops without a provider request when checking for .rooignore fails with EACCES", async () => {
			const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
			const accessDenied = Object.assign(new Error("permission denied"), { code: "EACCES" })
			const stat = vi.spyOn(fs, "lstat").mockRejectedValue(accessDenied)
			try {
				mockRepo = makeRepo(root)
				useOnlyRepository(mockRepo)
				mockRepo.diff = vi.fn().mockResolvedValue("diff --git a/.env b/.env\n@@ -1 +1 @@\n+DB=hunter2")

				await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

				expect(stat).toHaveBeenCalledWith(path.join(root, ".rooignore"))
				expect(singleCompletionHandler).not.toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
					`Failed to generate commit message: ${ROOIGNORE_UNREADABLE_MESSAGE}`,
				)
			} finally {
				stat.mockRestore()
				await rm(root, { recursive: true, force: true })
			}
		})

		it("finds a renamed file by its original path behind custom prefixes", async () => {
			const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
			try {
				await writeFile(path.join(root, ".rooignore"), ".env\n")
				const renamed = {
					uri: vscode.Uri.file(path.join(root, "moved.txt")),
					originalUri: vscode.Uri.file(path.join(root, ".env")),
					status: 3,
				}
				mockRepo = makeRepo(root, { state: { indexChanges: [renamed] } })
				useOnlyRepository(mockRepo)
				// Without rename detection, the diff shows the old file as deleted.
				const diff = "diff --git old-.env new-.env\n--- old-.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-DB=hunter5"
				mockRepo.diff = vi.fn().mockResolvedValue(diff)
				;(singleCompletionHandler as Mock).mockResolvedValue("chore: move config")

				await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

				expect((singleCompletionHandler as Mock).mock.calls[0][1]).not.toContain("hunter5")
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		})

		it.skipIf(process.platform === "win32")(
			"stops without a provider request when .rooignore is a link to a missing file",
			async () => {
				const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
				try {
					await symlink(path.join(root, "missing-rules"), path.join(root, ".rooignore"))
					mockRepo = makeRepo(root)
					useOnlyRepository(mockRepo)
					mockRepo.diff = vi.fn().mockResolvedValue("diff --git a/.env b/.env\n@@ -1 +1 @@\n+DB=hunter2")

					await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

					expect(singleCompletionHandler).not.toHaveBeenCalled()
					expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
						`Failed to generate commit message: ${ROOIGNORE_UNREADABLE_MESSAGE}`,
					)
				} finally {
					await rm(root, { recursive: true, force: true })
				}
			},
		)

		it("sends the diff unchanged when the repository has no .rooignore", async () => {
			const root = await mkdtemp(path.join(tmpdir(), "zoo-commit-"))
			try {
				mockRepo = makeRepo(root)
				useOnlyRepository(mockRepo)
				const diff = "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+DB=example"
				mockRepo.diff = vi.fn().mockResolvedValue(diff)
				;(singleCompletionHandler as Mock).mockResolvedValue("chore: update config")

				await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

				expect((singleCompletionHandler as Mock).mock.calls[0][1]).toContain(diff)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		})

		it("does not read the working tree when cancelled while the staged diff is pending", async () => {
			const { cancel } = useCancellableProgress()
			const stagedDiff = deferred<string>()
			mockRepo.diff = vi.fn((cached?: boolean) => (cached ? stagedDiff.promise : Promise.resolve("working diff")))

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockRepo.diff).toHaveBeenCalledWith(true))
			cancel()
			await run
			stagedDiff.resolve("")
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockRepo.diff).toHaveBeenCalledTimes(1)
			expect(mockProvider.getState).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		it("waits for a cancelled request that ignores the abort before it sends the retry", async () => {
			const { cancel } = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => cancelledRequest.promise)
				.mockResolvedValueOnce("feat: retry")

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			cancel()
			await first

			const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			await new Promise((resolve) => setTimeout(resolve, 0))
			// The retry does not start a second provider request while the cancelled one runs.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			cancelledRequest.resolve("feat: cancelled")
			await retry

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: retry")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("lets the user cancel a retry while it waits for the cancelled request", async () => {
			const firstProgress = useCancellableProgress({ once: true })
			const retryProgress = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock).mockImplementationOnce(() => cancelledRequest.promise)

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			firstProgress.cancel()
			await first

			const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			retryProgress.cancel()
			await retry

			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
			expect(mockRepo.inputBox.value).toBe("")
			// A user cancel ends the wait quietly, without the "previous request is still running" warning.
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			cancelledRequest.resolve("feat: cancelled")
		})

		it("stops the retry with a message, without a second request, when the cancelled request outlasts the wait limit", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const { cancel } = useCancellableProgress({ once: true })
				const report = vi.fn()
				;(singleCompletionHandler as Mock).mockImplementationOnce(() => new Promise(() => {}))

				const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
				cancel()
				await first

				;(vscode.window.withProgress as Mock).mockImplementationOnce((_opts, callback) =>
					callback(
						{ report },
						{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) },
					),
				)
				const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				// vi.waitFor advances fake timers by its poll interval, so keep a margin below the limit.
				await vi.waitFor(
					() => expect(report).toHaveBeenCalledWith({ message: WAITING_FOR_PREVIOUS_REQUEST_MESSAGE }),
					{ interval: 1 },
				)
				await vi.advanceTimersByTimeAsync(PREVIOUS_REQUEST_WAIT_MS - 1_000)
				expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

				await vi.advanceTimersByTimeAsync(1_000)
				await retry

				expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE)
				expect(mockRepo.inputBox.value).toBe("")
			} finally {
				vi.useRealTimers()
			}
		})

		it("clears the wait timer when the user cancels the wait", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const first = useCancellableProgress({ once: true })
				;(singleCompletionHandler as Mock).mockImplementationOnce(() => new Promise(() => {}))
				const firstRun = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
				first.cancel()
				await firstRun

				const retryProgress = useCancellableProgress({ once: true })
				const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 1 })
				retryProgress.cancel()
				await retry

				await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0), { interval: 1 })
				expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it.each([
			["succeeds", () => (singleCompletionHandler as Mock).mockResolvedValue("feat: done")],
			["fails", () => (singleCompletionHandler as Mock).mockRejectedValue(new Error("provider failed"))],
			["finds no Git extension", () => (vscode.extensions.getExtension as Mock).mockReturnValue(undefined)],
		])("removes the per-repository request state when the last request %s", async (_label, arrange) => {
			arrange()

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			await vi.waitFor(() => expect(commitMessageRequestStateSize()).toBe(0))
		})

		it("removes the request state after runs that stop before they find a repository", async () => {
			const noRepositories: GitAPI = { repositories: [] }
			;(vscode.extensions.getExtension as Mock)
				.mockReturnValueOnce(undefined)
				.mockReturnValueOnce({ isActive: true, exports: { getAPI: () => noRepositories } })
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: done")

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			expect(vscode.window.showErrorMessage).toHaveBeenNthCalledWith(1, "Git extension not found or not enabled.")
			expect(vscode.window.showErrorMessage).toHaveBeenNthCalledWith(2, "No Git repository found.")
			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(mockRepo.inputBox.value).toBe("feat: done")
			await vi.waitFor(() => expect(commitMessageRequestStateSize()).toBe(0))
		})

		it("does not let an older request that is still resolving Git replace a newer result", async () => {
			const activation = deferred<void>()
			const gitApi: GitAPI = { repositories: [mockRepo] }
			;(vscode.extensions.getExtension as Mock).mockReturnValueOnce({
				isActive: false,
				activate: () => activation.promise,
				exports: { getAPI: () => gitApi },
			})
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: newer")

			const older = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			expect(mockRepo.inputBox.value).toBe("feat: newer")
			mockRepo.inputBox.value = "typed after the newer result"
			activation.resolve()
			await older

			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
			expect(mockRepo.inputBox.value).toBe("typed after the newer result")
			await vi.waitFor(() => expect(commitMessageRequestStateSize()).toBe(0))
		})

		it("does not wait when the cancelled request already settled", async () => {
			const { cancel } = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => cancelledRequest.promise)
				.mockResolvedValueOnce("feat: retry")

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			cancel()
			await first
			cancelledRequest.resolve("feat: cancelled")
			await new Promise((resolve) => setTimeout(resolve, 0))

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: retry")
		})

		it("does not report a provider rejection that arrives after cancellation", async () => {
			const { cancel } = useCancellableProgress()
			let rejectCompletion: (error: Error) => void = () => {}
			;(singleCompletionHandler as Mock).mockImplementation(
				() =>
					new Promise((_resolve, reject) => {
						rejectCompletion = reject
					}),
			)

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run
			rejectCompletion(new Error("late provider failure"))
			await Promise.resolve()

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("shows error if no valid API provider is configured", async () => {
			mockProvider.getState = vi.fn().mockResolvedValue({
				apiConfiguration: {},
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"No valid API provider configured. Please configure an API provider in Zoo Code settings.",
			)
		})

		it("generates commit message and assigns it to inputBox.value", async () => {
			const apiConfiguration = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-sonnet-4-5",
				apiKey: "test-key",
			}
			;(mockProvider.getState as Mock).mockResolvedValue({ apiConfiguration })
			;(singleCompletionHandler as Mock).mockResolvedValue("feat(core): implement git commit message")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			// The configured provider and model reach the request unchanged, with the diff and an abort signal.
			expect(singleCompletionHandler).toHaveBeenCalledWith(
				apiConfiguration,
				expect.stringContaining("diff content"),
				{
					abortSignal: expect.any(AbortSignal),
				},
			)
			expect(mockRepo.inputBox.value).toBe("feat(core): implement git commit message")
		})

		it("does not update inputBox if cancelled", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: should be cancelled")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				let cancellationHandler: () => void = () => {}
				let isCancelled = false
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancellationHandler = fn
						return { dispose: vi.fn() }
					}),
				}
				cancellationHandler()
				isCancelled = true
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("")
		})

		it("skips provider and LLM call when cancelled while diff is pending", async () => {
			let isCancelled = false
			const cancellationHandlers: Array<() => void> = []
			// diff never resolves on its own — simulates a slow/stuck git process
			mockRepo.diff = vi.fn().mockImplementation(() => new Promise(() => {}))
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancellationHandlers.push(fn)
						return { dispose: vi.fn() }
					}),
				}
				// Trigger cancellation after the race has started (next microtask)
				void Promise.resolve().then(() => {
					isCancelled = true
					cancellationHandlers.forEach((fn) => fn())
				})
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockProvider.getState).not.toHaveBeenCalled()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("skips LLM call when cancelled after provider state resolves", async () => {
			let isCancelled = false
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})
			// Set cancelled = true inside getState so the guard after getState fires
			mockProvider.getState = vi.fn().mockImplementation(async () => {
				isCancelled = true
				return { apiConfiguration: { apiProvider: providerIdentifiers.openai, apiKey: "sk-test" } }
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("aborts the in-flight provider request when cancellation is requested", async () => {
			// Collect ALL registered cancellation handlers so both abortController.abort()
			// and the cancelPromise resolver are called when the test triggers cancellation.
			const registeredHandlers: Array<() => void> = []
			let triggerCancellation: () => void = () => {}
			let capturedSignal: AbortSignal | undefined
			;(singleCompletionHandler as Mock).mockImplementation((_config, _prompt, options) => {
				capturedSignal = options.abortSignal as AbortSignal
				triggerCancellation()
				return Promise.resolve("feat: should be cancelled")
			})
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((fn: () => void) => {
						registeredHandlers.push(fn)
						triggerCancellation = () => registeredHandlers.forEach((h) => h())
						return { dispose: vi.fn() }
					}),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(capturedSignal?.aborted).toBe(true)
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("does not update inputBox and shows warning if generated message is empty", async () => {
			mockRepo.inputBox.value = "preserved value"
			const mockDisposable = { dispose: vi.fn() }
			;(singleCompletionHandler as Mock).mockResolvedValue("   ")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue(mockDisposable),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("preserved value")
			expect(mockDisposable.dispose).toHaveBeenCalled()
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("No commit message generated.")
		})

		it("stays quiet when the provider rejects synchronously on the user's cancel", async () => {
			const { cancel } = useCancellableProgress()
			;(singleCompletionHandler as Mock).mockImplementation(
				(_config, _prompt, options: { abortSignal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						options.abortSignal.addEventListener("abort", () => {
							const abortError = new Error("This operation was aborted")
							abortError.name = "AbortError"
							reject(abortError)
						})
					}),
			)

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it.each([
			["a message that mentions 'aborted'", "request aborted by server", "Error"],
			["a provider timeout", "The operation was aborted due to timeout", "TimeoutError"],
			["an AbortError the user did not cause", "This operation was aborted", "AbortError"],
		])("reports %s when the user did not cancel", async (_label, message, name) => {
			const error = new Error(message)
			error.name = name
			;(singleCompletionHandler as Mock).mockRejectedValue(error)

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Failed to generate commit message: ${message}`)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(`[generateGitCommitMessage] failed: ${message}`)
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("handles non-Error objects gracefully and shows error message", async () => {
			;(vscode.window.withProgress as Mock).mockRejectedValue("String-based error")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[generateGitCommitMessage] failed: String-based error"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: String-based error",
			)
		})

		it("handles errors gracefully and shows error message", async () => {
			;(vscode.window.withProgress as Mock).mockRejectedValue(new Error("Network error"))

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[generateGitCommitMessage] failed: Network error"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: Network error",
			)
		})
	})
})
