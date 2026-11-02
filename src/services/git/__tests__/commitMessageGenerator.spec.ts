import * as vscode from "vscode"
import type { Mock } from "vitest"
import { providerIdentifiers } from "@roo-code/types"

import {
	buildCommitMessagePrompt,
	cleanCommitMessage,
	generateCommitMessage,
	getGitApi,
	getRepositoryDiff,
	redactSensitiveInformation,
	resolveGitRepository,
	type GitAPI,
	type GitRepository,
} from "../commitMessageGenerator"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { makeUri } from "../../../test-utils/vscode"

vi.mock("vscode", () => ({
	ProgressLocation: {
		Notification: 15,
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

describe("commitMessageGenerator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
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

	describe("redactSensitiveInformation", () => {
		it("redacts private keys", () => {
			const content =
				"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----\nother text"
			expect(redactSensitiveInformation(content)).toBe("[REDACTED_SECRET]\nother text")
		})

		it("redacts api keys and secrets", () => {
			const content = 'apiKey: "super-secret-key-12345"\npassword=mysecretpassword123\nother_config=123'
			const redacted = redactSensitiveInformation(content)
			expect(redacted).toContain('apiKey: "[REDACTED]"')
			expect(redacted).toContain("password=[REDACTED]")
			expect(redacted).toContain("other_config=123")
		})

		it("leaves normal diff content unchanged", () => {
			const content = "diff --git a/src/app.ts b/src/app.ts\n+console.log('hello world')"
			expect(redactSensitiveInformation(content)).toBe(content)
		})
	})

	describe("buildCommitMessagePrompt", () => {
		it("includes diff and instructions", () => {
			const prompt = buildCommitMessagePrompt("diff --git a/file b/file\n+test")
			expect(prompt).toContain("diff --git a/file b/file\n+test")
			expect(prompt).toContain("Conventional Commits")
		})

		it("redacts sensitive information in the prompt", () => {
			const prompt = buildCommitMessagePrompt("apiKey: 'secret_token_12345678'")
			expect(prompt).not.toContain("secret_token_12345678")
			expect(prompt).toContain("[REDACTED]")
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

		it("falls through if bare vscode.Uri context does not match any repository", () => {
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

			expect(resolveGitRepository(git, makeUri("/workspace/unknown"))).toBe(repo1)
		})

		it("falls through if scm context rootUri does not match any repository", () => {
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

			expect(resolveGitRepository(git, { rootUri: makeUri("/workspace/unknown") })).toBe(repo1)
		})

		it("falls through if scm context inputBox does not match any repository", () => {
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

			expect(resolveGitRepository(git, { inputBox: { value: "other" } })).toBe(repo1)
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

		it("falls back to working tree diff if staged diff throws", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.reject(new Error("Git diff staged failed"))
					return Promise.resolve("working diff fallback")
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBe("working diff fallback")
			expect(repo.diff).toHaveBeenCalledWith(true)
			expect(repo.diff).toHaveBeenCalledWith(false)
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

		it("returns undefined if working diff throws after empty staged diff", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("")
					return Promise.reject(new Error("Git working tree diff failed"))
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBeUndefined()
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

			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				"No staged or working directory changes found to generate commit message.",
			)
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

			expect(singleCompletionHandler).toHaveBeenCalled()
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

		it("aborts when token triggers cancellation callback", async () => {
			let cancellationHandler: (() => void) | undefined
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancellationHandler = fn
						return { dispose: vi.fn() }
					}),
				}
				return callback(progress, token)
			})
			;(singleCompletionHandler as Mock).mockImplementation(async (_config, _prompt, options) => {
				cancellationHandler?.()
				expect(options.abortSignal.aborted).toBe(true)
				return ""
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("")
		})

		it("aborts the in-flight provider request when cancellation is requested", async () => {
			let cancelHandler: () => void = () => {}
			let capturedSignal: AbortSignal | undefined
			;(singleCompletionHandler as Mock).mockImplementation((_config, _prompt, options) => {
				capturedSignal = options.abortSignal as AbortSignal
				cancelHandler()
				return Promise.resolve("feat: should be cancelled")
			})
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancelHandler = fn
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

		it("ignores AbortError without showing an error message", async () => {
			const abortError = new Error("This operation was aborted")
			abortError.name = "AbortError"
			;(vscode.window.withProgress as Mock).mockRejectedValue(abortError)

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
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
