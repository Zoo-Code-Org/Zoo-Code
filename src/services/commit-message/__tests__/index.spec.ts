import * as vscode from "vscode"

import { generateCommitMessage, stopGeneratingCommitMessage } from "../index"
import * as gitModule from "../../../utils/git"
import * as generatorModule from "../generator"
import * as configModule from "../config"
import type { CommitContext } from "../../../utils/git"
import type { ClineProvider } from "../../../core/webview/ClineProvider"

vi.mock("vscode", () => ({
	extensions: { getExtension: vi.fn() },
	commands: { executeCommand: vi.fn() },
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		// Run the task immediately so assertions don't have to await a real progress UI.
		withProgress: vi.fn((_options: unknown, task: () => Promise<string | undefined>) => task()),
	},
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	Uri: { file: (fsPath: string) => ({ fsPath }) },
}))

vi.mock("../../../utils/git")
vi.mock("../generator")
vi.mock("../config")
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("generateCommitMessage (Source Control integration)", () => {
	const context: CommitContext = {
		branch: "main",
		recentCommits: [],
		files: [{ status: "modified", path: "src/file1.ts" }],
		diff: "+new line",
	}

	const provider = {} as ClineProvider

	let inputBox: { value: string }

	const mockRepositories = (repositories: Array<{ rootUri: { fsPath: string }; inputBox: { value: string } }>) => {
		vi.mocked(vscode.extensions.getExtension).mockReturnValue({
			isActive: true,
			exports: { getAPI: () => ({ repositories }) },
		} as never)
	}

	/** The source control the SCM menus hand to both commands, identifying the repository clicked. */
	const sourceControl = { rootUri: { fsPath: "/repo" } } as vscode.SourceControl

	/** The value the given `setContext` call published for the button-swapping key. */
	const contextKeyUpdates = () =>
		vi
			.mocked(vscode.commands.executeCommand)
			.mock.calls.filter(
				([command, key]) => command === "setContext" && key === "zoo-code.generatingCommitMessage",
			)
			.map(([, , value]) => value)

	/**
	 * Starts a generation the model never answers, stops it from the Source Control button, and
	 * waits for the command to settle - which is what the user sees as the square reverting.
	 */
	const startThenStop = async (repository = sourceControl) => {
		vi.mocked(generatorModule.generateCommitMessage).mockReturnValue(new Promise<string>(() => {}))

		const pending = generateCommitMessage(provider, repository)

		// Let the awaits before the request settle, so there is something in flight to stop.
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		await stopGeneratingCommitMessage(repository)

		return pending
	}

	beforeEach(() => {
		vi.clearAllMocks()

		inputBox = { value: "" }
		mockRepositories([{ rootUri: { fsPath: "/repo" }, inputBox }])

		vi.mocked(gitModule.getCommitContext).mockResolvedValue({ ok: true, context })
		vi.mocked(generatorModule.generateCommitMessage).mockResolvedValue("feat: add a thing")
		vi.mocked(configModule.getCommitMessageSettings).mockResolvedValue({
			apiConfiguration: { apiProvider: "openai" },
			customSupportPrompts: {},
			timeoutMs: 60_000,
		})
	})

	it("writes the generated message into the commit input box", async () => {
		await generateCommitMessage(provider)

		expect(inputBox.value).toBe("feat: add a thing")
	})

	it("picks the repository matching the clicked source control", async () => {
		const otherInputBox = { value: "" }

		mockRepositories([
			{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
			{ rootUri: { fsPath: "/repo" }, inputBox },
		])

		await generateCommitMessage(provider, { rootUri: { fsPath: "/repo" } } as vscode.SourceControl)

		expect(inputBox.value).toBe("feat: add a thing")
		expect(otherInputBox.value).toBe("")
	})

	// Guessing would eventually describe another repository's changes, which is worse than
	// writing nothing at all.
	it("refuses to guess between repositories when none was clicked", async () => {
		const otherInputBox = { value: "" }

		mockRepositories([
			{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
			{ rootUri: { fsPath: "/repo" }, inputBox },
		])

		await generateCommitMessage(provider)

		expect(inputBox.value).toBe("")
		expect(otherInputBox.value).toBe("")
		expect(generatorModule.generateCommitMessage).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_ambiguous_repository")
	})

	it("reports an error when the clicked repository is not among the known ones", async () => {
		await generateCommitMessage(provider, { rootUri: { fsPath: "/elsewhere" } } as vscode.SourceControl)

		expect(generatorModule.generateCommitMessage).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_no_repository")
	})

	describe("never overwrites what the user typed", () => {
		it("leaves an existing draft alone and does not spend a request on it", async () => {
			inputBox.value = "wip: my own message"

			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("wip: my own message")
			expect(generatorModule.generateCommitMessage).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				"common:info.commit_message_box_not_empty",
			)
		})

		it("keeps text typed while the request was in flight", async () => {
			vi.mocked(generatorModule.generateCommitMessage).mockImplementation(async () => {
				inputBox.value = "typed while waiting"
				return "feat: add a thing"
			})

			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("typed while waiting")
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				"common:info.commit_message_box_not_empty",
			)
		})

		it("treats a whitespace-only box as empty", async () => {
			inputBox.value = "   "

			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("feat: add a thing")
		})
	})

	describe("reports why there is nothing to describe", () => {
		it("says so when there are no changes", async () => {
			vi.mocked(gitModule.getCommitContext).mockResolvedValue({ ok: false, reason: "no-changes" })

			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("")
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:info.commit_message_no_changes")
		})

		// Only the index is described, so this is the one failure the user can act on directly.
		it("asks the user to stage something when the index is empty", async () => {
			vi.mocked(gitModule.getCommitContext).mockResolvedValue({ ok: false, reason: "nothing-staged" })

			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("")
			expect(generatorModule.generateCommitMessage).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				"common:info.commit_message_nothing_staged",
			)
		})

		it("reports a missing repository when git cannot describe the folder", async () => {
			vi.mocked(gitModule.getCommitContext).mockResolvedValue({ ok: false, reason: "not-a-repo" })

			await generateCommitMessage(provider)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_no_repository")
		})

		it("surfaces a collection failure", async () => {
			vi.mocked(gitModule.getCommitContext).mockResolvedValue({
				ok: false,
				reason: "failed",
				error: "maxBuffer exceeded",
			})

			await generateCommitMessage(provider)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_failed")
		})

		it("reports an error when the git extension is unavailable", async () => {
			vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined)

			await generateCommitMessage(provider)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_no_repository")
		})
	})

	it("reports progress in the Source Control view rather than a notification", async () => {
		await generateCommitMessage(provider)

		// The way out is the stop button, not a cancel button on a toast, so this deliberately does
		// not use `Notification`. `SourceControl` drops the title, hence there being none to pass.
		const [options] = vi.mocked(vscode.window.withProgress).mock.calls[0]
		expect(options.location).toBe(vscode.ProgressLocation.SourceControl)
		expect(options.title).toBeUndefined()
		expect(options.cancellable).toBeUndefined()
	})

	// The context key is what swaps the Source Control button between the two commands, so it has
	// to be true for exactly as long as there is something to stop.
	describe("the button-swapping context key", () => {
		it("goes up before the request and back down after it", async () => {
			await generateCommitMessage(provider)

			expect(contextKeyUpdates()).toEqual([true, false])
		})

		it("is raised before the diff is collected, which is the slow part on a large repo", async () => {
			vi.mocked(gitModule.getCommitContext).mockImplementation(async () => {
				expect(contextKeyUpdates()).toEqual([true])
				return { ok: true, context }
			})

			await generateCommitMessage(provider)

			expect(gitModule.getCommitContext).toHaveBeenCalled()
		})

		it("comes back down when generation fails", async () => {
			vi.mocked(generatorModule.generateCommitMessage).mockRejectedValue(new Error("provider exploded"))

			await generateCommitMessage(provider)

			expect(contextKeyUpdates()).toEqual([true, false])
		})

		it("comes back down when there was nothing to describe", async () => {
			vi.mocked(gitModule.getCommitContext).mockResolvedValue({ ok: false, reason: "nothing-staged" })

			await generateCommitMessage(provider)

			expect(contextKeyUpdates()).toEqual([true, false])
		})

		// One repository finishing must not put the other's button back to the zebra while it is
		// still generating, so the key tracks how many are in flight rather than the last event.
		it("stays up while another repository is still generating", async () => {
			const otherInputBox = { value: "" }

			mockRepositories([
				{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
				{ rootUri: { fsPath: "/repo" }, inputBox },
			])

			const slow = new Promise<string>(() => {})
			vi.mocked(generatorModule.generateCommitMessage).mockReturnValueOnce(slow)

			const pending = generateCommitMessage(provider, { rootUri: { fsPath: "/other" } } as vscode.SourceControl)
			await Promise.resolve()

			vi.mocked(generatorModule.generateCommitMessage).mockResolvedValue("feat: add a thing")
			await generateCommitMessage(provider, sourceControl)

			expect(inputBox.value).toBe("feat: add a thing")
			expect(contextKeyUpdates()).not.toContain(false)

			await stopGeneratingCommitMessage({ rootUri: { fsPath: "/other" } } as vscode.SourceControl)
			await pending

			expect(contextKeyUpdates().at(-1)).toBe(false)
		})
	})

	// Most providers ignore the abort signal, so a request that never answers cannot be stopped -
	// only stopped being waited on. Without this bound the indicator stays up until the window is
	// reloaded, which is what a stalled cloud provider actually did.
	describe("timeout", () => {
		beforeEach(() => vi.useFakeTimers())
		afterEach(() => vi.useRealTimers())

		/** Starts generation against a provider that never answers, then trips the timeout. */
		const runUntilTimeout = async () => {
			vi.mocked(generatorModule.generateCommitMessage).mockReturnValue(new Promise<string>(() => {}))

			const pending = generateCommitMessage(provider)

			// Let the awaits before the request settle so the timer is actually scheduled.
			await vi.advanceTimersByTimeAsync(0)
			await vi.advanceTimersByTimeAsync(60_000)

			return pending
		}

		it("gives up and says why", async () => {
			await runUntilTimeout()

			expect(inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_timeout")
		})

		it("aborts the request so providers that honour the signal can drop it", async () => {
			await runUntilTimeout()

			const [options] = vi.mocked(generatorModule.generateCommitMessage).mock.calls[0]
			expect(options.abortSignal?.aborted).toBe(true)
		})

		it("releases the repository so the next attempt is not blocked", async () => {
			await runUntilTimeout()

			vi.mocked(generatorModule.generateCommitMessage).mockResolvedValue("feat: add a thing")
			await generateCommitMessage(provider)

			expect(inputBox.value).toBe("feat: add a thing")
		})

		it("does not fire once the message has arrived", async () => {
			await generateCommitMessage(provider)
			await vi.advanceTimersByTimeAsync(120_000)

			expect(inputBox.value).toBe("feat: add a thing")
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})
	})

	describe("stopping from the Source Control button", () => {
		it("leaves the box alone and says nothing", async () => {
			await startThenStop()

			expect(inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		it("aborts the request so providers that honour the signal can drop it", async () => {
			await startThenStop()

			const [options] = vi.mocked(generatorModule.generateCommitMessage).mock.calls[0]
			expect(options.abortSignal?.aborted).toBe(true)
		})

		// The request outlives the stop for providers that ignore the signal, so a late rejection
		// must not resurface as an unhandled rejection or an error toast.
		it("swallows a rejection that arrives after stopping", async () => {
			let reject: (error: Error) => void = () => {}
			vi.mocked(generatorModule.generateCommitMessage).mockReturnValue(
				new Promise<string>((_resolve, r) => (reject = r)),
			)

			const pending = generateCommitMessage(provider, sourceControl)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			await stopGeneratingCommitMessage(sourceControl)
			reject(new Error("aborted by provider"))

			await expect(pending).resolves.toBeUndefined()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("releases the repository so the next attempt is not blocked", async () => {
			await startThenStop()

			vi.mocked(generatorModule.generateCommitMessage).mockResolvedValue("feat: add a thing")
			await generateCommitMessage(provider, sourceControl)

			expect(inputBox.value).toBe("feat: add a thing")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
				"common:info.commit_message_already_generating",
			)
		})

		it("puts the button back", async () => {
			await startThenStop()

			expect(contextKeyUpdates()).toEqual([true, false])
		})

		// Collecting the diff shells out to git and cannot be interrupted, so the only thing a stop
		// can do there is make sure no request is ever issued.
		it("never reaches the model when stopped while the diff is being collected", async () => {
			vi.mocked(gitModule.getCommitContext).mockImplementation(async () => {
				await stopGeneratingCommitMessage(sourceControl)
				return { ok: true, context }
			})

			await generateCommitMessage(provider, sourceControl)

			expect(generatorModule.generateCommitMessage).not.toHaveBeenCalled()
			expect(inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		// The context key is workspace-wide, so the button is also on repositories with nothing in
		// flight. Pressing it there must not stop a different repository's request.
		it("does nothing on a repository that is not generating", async () => {
			const otherInputBox = { value: "" }

			mockRepositories([
				{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
				{ rootUri: { fsPath: "/repo" }, inputBox },
			])

			vi.mocked(generatorModule.generateCommitMessage).mockReturnValue(new Promise<string>(() => {}))

			const pending = generateCommitMessage(provider, sourceControl)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			await stopGeneratingCommitMessage({ rootUri: { fsPath: "/other" } } as vscode.SourceControl)

			const [options] = vi.mocked(generatorModule.generateCommitMessage).mock.calls[0]
			expect(options.abortSignal?.aborted).toBe(false)

			await stopGeneratingCommitMessage(sourceControl)
			await pending
		})

		it("does nothing when the clicked repository is unknown", async () => {
			vi.mocked(generatorModule.generateCommitMessage).mockReturnValue(new Promise<string>(() => {}))

			const pending = generateCommitMessage(provider, sourceControl)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			await stopGeneratingCommitMessage({ rootUri: { fsPath: "/elsewhere" } } as vscode.SourceControl)

			const [options] = vi.mocked(generatorModule.generateCommitMessage).mock.calls[0]
			expect(options.abortSignal?.aborted).toBe(false)

			await stopGeneratingCommitMessage(sourceControl)
			await pending
		})
	})

	it("surfaces generation failures instead of throwing", async () => {
		vi.mocked(generatorModule.generateCommitMessage).mockRejectedValue(new Error("boom"))

		await expect(generateCommitMessage(provider)).resolves.toBeUndefined()
		expect(inputBox.value).toBe("")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_failed")
	})

	// The command sits behind a toolbar button, so it is easy to click again while a slow model is
	// still answering. Each extra click would otherwise stack another status-bar spinner.
	describe("ignores clicks while a request is already in flight", () => {
		/**
		 * Leaves generation pending until the returned `resolve` is called, and exposes a promise
		 * that settles once generation has actually been entered - the command awaits git
		 * collection and settings first, so a second call made before that would race the guard.
		 */
		const pendingGeneration = () => {
			let resolve: (message: string) => void = () => {}
			let entered: () => void = () => {}

			const pending = new Promise<string>((r) => (resolve = r))
			const started = new Promise<void>((r) => (entered = r))

			vi.mocked(generatorModule.generateCommitMessage).mockImplementation(() => {
				entered()
				return pending
			})

			return { resolve, started }
		}

		it("does not start a second request for the same repository", async () => {
			const { resolve, started } = pendingGeneration()

			const first = generateCommitMessage(provider)
			await started
			await generateCommitMessage(provider)

			expect(generatorModule.generateCommitMessage).toHaveBeenCalledTimes(1)
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				"common:info.commit_message_already_generating",
			)

			resolve("feat: add a thing")
			await first

			expect(inputBox.value).toBe("feat: add a thing")
		})

		it("releases the repository once the request finishes", async () => {
			await generateCommitMessage(provider)
			inputBox.value = ""
			await generateCommitMessage(provider)

			expect(generatorModule.generateCommitMessage).toHaveBeenCalledTimes(2)
		})

		it("releases the repository after a failure", async () => {
			vi.mocked(generatorModule.generateCommitMessage).mockRejectedValueOnce(new Error("boom"))

			await generateCommitMessage(provider)
			await generateCommitMessage(provider)

			expect(generatorModule.generateCommitMessage).toHaveBeenCalledTimes(2)
		})

		it("lets a different repository generate at the same time", async () => {
			const otherInputBox = { value: "" }

			mockRepositories([
				{ rootUri: { fsPath: "/repo" }, inputBox },
				{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
			])

			const { resolve, started } = pendingGeneration()

			const first = generateCommitMessage(provider, { rootUri: { fsPath: "/repo" } } as never)
			await started

			const second = generateCommitMessage(provider, { rootUri: { fsPath: "/other" } } as never)

			resolve("feat: add a thing")
			await Promise.all([first, second])

			// The second repository was never blocked by the first one's in-flight request.
			expect(generatorModule.generateCommitMessage).toHaveBeenCalledTimes(2)
			expect(otherInputBox.value).toBe("feat: add a thing")
		})
	})
})
