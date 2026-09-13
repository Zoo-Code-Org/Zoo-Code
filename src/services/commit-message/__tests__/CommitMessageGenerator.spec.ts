import type { ProviderSettings } from "@roo-code/types"

import { CommitMessageGenerator } from "../CommitMessageGenerator"

describe("CommitMessageGenerator", () => {
	const defaultConfig: ProviderSettings = { apiProvider: "openai", openAiApiKey: "default-key" }
	const commitConfig: ProviderSettings = { apiProvider: "anthropic", apiKey: "commit-key" }
	const providerSettingsManager = {
		initialize: vi.fn(),
		getProfile: vi.fn(),
	}
	const contextProxy = {
		isInitialized: true,
		getProviderSettings: vi.fn(),
		getValue: vi.fn(),
	}
	const completePrompt = vi.fn()
	const addCustomInstructions = vi.fn()
	const captureGenerated = vi.fn()
	const warn = vi.fn()

	/** Creates a generator with mocked provider and configuration dependencies. */
	const createGenerator = () =>
		new CommitMessageGenerator(providerSettingsManager as any, {
			getContextProxy: () => contextProxy,
			completePrompt,
			addCustomInstructions: addCustomInstructions as any,
			captureGenerated,
			logger: { warn },
		})

	beforeEach(() => {
		vi.clearAllMocks()
		contextProxy.isInitialized = true
		contextProxy.getProviderSettings.mockReturnValue(defaultConfig)
		contextProxy.getValue.mockImplementation((key: string) => {
			switch (key) {
				case "commitMessageApiConfigId":
					return undefined
				case "listApiConfigMeta":
					return []
				case "customSupportPrompts":
					return {}
				default:
					return undefined
			}
		})
		addCustomInstructions.mockResolvedValue("Follow repo commit rules.")
		completePrompt.mockResolvedValue("```\nfeat(core): add commit generator\n```")
		providerSettingsManager.initialize.mockResolvedValue(undefined)
		providerSettingsManager.getProfile.mockResolvedValue({ name: "Commit profile", ...commitConfig })
	})

	it("fails before progress or AI calls when git context has no changes", async () => {
		const onProgress = vi.fn()
		const generator = createGenerator()

		await expect(
			generator.generateMessage({
				workspacePath: "/repo",
				selectedFiles: [],
				gitContext: `## Git Context

### Full Diff of Staged Changes
\`\`\`diff
\`\`\`

### Change Summary
\`\`\`
(No changes matched selection)
\`\`\``,
				onProgress,
			}),
		).rejects.toThrow("No changes to generate a commit message for")

		expect(onProgress).not.toHaveBeenCalled()
		expect(completePrompt).not.toHaveBeenCalled()
		expect(captureGenerated).not.toHaveBeenCalled()
	})

	it("sends the full git context to the LLM and returns cleaned commit text", async () => {
		const gitContext = `## Git Context

### Full Diff of Staged Changes
\`\`\`diff
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const value = 1
\`\`\``
		const generator = createGenerator()

		const message = await generator.generateMessage({
			workspacePath: "/repo",
			selectedFiles: ["src/new.ts"],
			gitContext,
		})

		expect(message).toBe("feat(core): add commit generator")
		expect(completePrompt).toHaveBeenCalledTimes(1)
		const [config, prompt] = completePrompt.mock.calls[0]
		expect(config).toBe(defaultConfig)
		expect(prompt).toContain("# Conventional Commit Message Generator")
		expect(prompt).toContain("Follow repo commit rules.")
		expect(prompt).toContain(gitContext)
		expect(captureGenerated).toHaveBeenCalledTimes(1)
	})

	it("uses the selected commit-message API profile when configured", async () => {
		contextProxy.getValue.mockImplementation((key: string) => {
			switch (key) {
				case "commitMessageApiConfigId":
					return "commit-profile"
				case "listApiConfigMeta":
					return [{ id: "commit-profile", name: "Commit profile" }]
				case "customSupportPrompts":
					return {}
				default:
					return undefined
			}
		})
		completePrompt.mockResolvedValue("fix(git): include untracked file diffs")
		const generator = createGenerator()

		await generator.generateMessage({
			workspacePath: "/repo",
			selectedFiles: ["src/new.ts"],
			gitContext: "diff --git a/src/new.ts b/src/new.ts",
		})

		expect(providerSettingsManager.initialize).toHaveBeenCalledTimes(1)
		expect(providerSettingsManager.getProfile).toHaveBeenCalledWith({ id: "commit-profile" })
		expect(completePrompt).toHaveBeenCalledWith(
			expect.objectContaining(commitConfig),
			expect.stringContaining("diff --git a/src/new.ts b/src/new.ts"),
		)
	})

	it("falls back to current API config when the selected profile cannot be loaded", async () => {
		contextProxy.getValue.mockImplementation((key: string) => {
			switch (key) {
				case "commitMessageApiConfigId":
					return "deleted-profile"
				case "listApiConfigMeta":
					return [{ id: "deleted-profile", name: "Deleted profile" }]
				case "customSupportPrompts":
					return {}
				default:
					return undefined
			}
		})
		providerSettingsManager.getProfile.mockRejectedValue(new Error("missing profile"))
		const generator = createGenerator()

		await generator.generateMessage({
			workspacePath: "/repo",
			selectedFiles: ["src/new.ts"],
			gitContext: "diff --git a/src/new.ts b/src/new.ts",
		})

		expect(completePrompt).toHaveBeenCalledWith(defaultConfig, expect.any(String))
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to load commit message API profile deleted-profile"),
			expect.any(Error),
		)
	})

	it("asks for a different message when regenerating for the same git context", async () => {
		completePrompt.mockResolvedValueOnce("feat(git): collect git context")
		completePrompt.mockResolvedValueOnce("chore(git): improve diff handling")
		const generator = createGenerator()
		const gitContext = "diff --git a/src/file.ts b/src/file.ts"

		await generator.generateMessage({ workspacePath: "/repo", selectedFiles: ["src/file.ts"], gitContext })
		await generator.generateMessage({ workspacePath: "/repo", selectedFiles: ["src/file.ts"], gitContext })

		const secondPrompt = completePrompt.mock.calls[1][1]
		expect(secondPrompt).toContain("GENERATE A COMPLETELY DIFFERENT COMMIT MESSAGE")
		expect(secondPrompt).toContain('The previous message was: "feat(git): collect git context"')
		expect(secondPrompt).toContain(gitContext)
	})

	it("cleans formatting wrappers without enforcing conventional commit format", async () => {
		completePrompt.mockResolvedValue(`\`\`\`
Update Git context parsing for staged-only entries

Keep unstaged commit context focused on worktree changes.
\`\`\``)
		const generator = createGenerator()

		const message = await generator.generateMessage({
			workspacePath: "/repo",
			selectedFiles: ["src/file.ts"],
			gitContext: "Modified (staged): src/file.ts",
		})

		expect(message).toBe(`Update Git context parsing for staged-only entries

Keep unstaged commit context focused on worktree changes.`)
	})
})
