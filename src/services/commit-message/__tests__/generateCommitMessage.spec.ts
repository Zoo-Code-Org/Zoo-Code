import * as vscode from "vscode"

import type { ProviderSettings } from "@roo-code/types"

import { generateCommitMessage } from "../index"
import * as gitModule from "../../../utils/git"
import * as singleCompletionHandlerModule from "../../../utils/single-completion-handler"
import type { ClineProvider } from "../../../core/webview/ClineProvider"

vi.mock("vscode", () => ({
	extensions: { getExtension: vi.fn() },
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		// Run the task immediately so assertions don't have to await a real progress UI.
		withProgress: vi.fn((_options: unknown, task: () => Promise<void>) => task()),
	},
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	Uri: { file: (fsPath: string) => ({ fsPath }) },
}))

vi.mock("../../../utils/git")
vi.mock("../../../utils/single-completion-handler")
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("generateCommitMessage", () => {
	const apiConfiguration: ProviderSettings = { apiProvider: "openai", apiKey: "key", apiModelId: "gpt-4" }

	const listApiConfigMeta = [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	]

	const commitProfile = {
		name: "Commit Config",
		apiProvider: "anthropic" as const,
		apiKey: "commit-key",
		apiModelId: "claude-3",
	}

	let inputBox: { value: string }
	let getProfile: ReturnType<typeof vi.fn>

	const makeProvider = (commitMessageApiConfigId?: string) =>
		({
			getState: vi.fn().mockResolvedValue({
				apiConfiguration,
				listApiConfigMeta,
				customSupportPrompts: {},
				commitMessageApiConfigId,
			}),
			providerSettingsManager: { getProfile },
		}) as unknown as ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()

		inputBox = { value: "" }
		getProfile = vi.fn().mockResolvedValue(commitProfile)

		vi.mocked(vscode.extensions.getExtension).mockReturnValue({
			isActive: true,
			exports: {
				getAPI: () => ({ repositories: [{ rootUri: { fsPath: "/repo" }, inputBox }] }),
			},
		} as never)

		vi.mocked(gitModule.getCommitContext).mockResolvedValue("Staged changes:\n\n+new line")
		vi.mocked(singleCompletionHandlerModule.singleCompletionHandler).mockResolvedValue("feat: add a thing")
	})

	it("writes the generated message into the commit input box", async () => {
		await generateCommitMessage(makeProvider())

		expect(inputBox.value).toBe("feat: add a thing")
		expect(singleCompletionHandlerModule.singleCompletionHandler).toHaveBeenCalledWith(
			apiConfiguration,
			expect.stringContaining("Staged changes:"),
		)
	})

	it("strips code fences and surrounding quotes from the model output", async () => {
		vi.mocked(singleCompletionHandlerModule.singleCompletionHandler).mockResolvedValue(
			'```\n"fix: correct the off-by-one"\n```',
		)

		await generateCommitMessage(makeProvider())

		expect(inputBox.value).toBe("fix: correct the off-by-one")
	})

	it("uses the dedicated profile when one is configured", async () => {
		await generateCommitMessage(makeProvider("config2"))

		expect(getProfile).toHaveBeenCalledWith({ id: "config2" })
		expect(singleCompletionHandlerModule.singleCompletionHandler).toHaveBeenCalledWith(
			{ apiProvider: "anthropic", apiKey: "commit-key", apiModelId: "claude-3" },
			expect.any(String),
		)
	})

	it("falls back to the active configuration when the configured profile no longer exists", async () => {
		await generateCommitMessage(makeProvider("deleted-config"))

		expect(getProfile).not.toHaveBeenCalled()
		expect(singleCompletionHandlerModule.singleCompletionHandler).toHaveBeenCalledWith(
			apiConfiguration,
			expect.any(String),
		)
	})

	it("picks the repository matching the clicked source control", async () => {
		const otherInputBox = { value: "" }

		vi.mocked(vscode.extensions.getExtension).mockReturnValue({
			isActive: true,
			exports: {
				getAPI: () => ({
					repositories: [
						{ rootUri: { fsPath: "/other" }, inputBox: otherInputBox },
						{ rootUri: { fsPath: "/repo" }, inputBox },
					],
				}),
			},
		} as never)

		await generateCommitMessage(makeProvider(), { rootUri: { fsPath: "/repo" } } as vscode.SourceControl)

		expect(inputBox.value).toBe("feat: add a thing")
		expect(otherInputBox.value).toBe("")
	})

	it("reports no changes and leaves the input box untouched", async () => {
		vi.mocked(gitModule.getCommitContext).mockResolvedValue(null)

		await generateCommitMessage(makeProvider())

		expect(inputBox.value).toBe("")
		expect(singleCompletionHandlerModule.singleCompletionHandler).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:info.commit_message_no_changes")
	})

	it("reports an error when the git extension is unavailable", async () => {
		vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined)

		await generateCommitMessage(makeProvider())

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_no_repository")
	})

	it("reports progress somewhere the title is actually rendered", async () => {
		await generateCommitMessage(makeProvider())

		// `ProgressLocation.SourceControl` silently drops the title, so a regression back to it
		// would leave the user with an unlabelled spinner.
		const [options] = vi.mocked(vscode.window.withProgress).mock.calls[0]
		expect(options.location).toBe(vscode.ProgressLocation.Window)
		expect(options.title).toBeTruthy()
	})

	it("surfaces generation failures instead of throwing", async () => {
		vi.mocked(singleCompletionHandlerModule.singleCompletionHandler).mockRejectedValue(new Error("boom"))

		await expect(generateCommitMessage(makeProvider())).resolves.toBeUndefined()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.commit_message_failed")
	})
})
