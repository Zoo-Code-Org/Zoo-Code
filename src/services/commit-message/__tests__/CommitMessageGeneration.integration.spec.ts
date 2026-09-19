import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { promises as fs } from "fs"
import type { ProviderSettings } from "@roo-code/types"

import { GitContextCollector } from "../../git-context"
import { CommitMessageGenerator } from "../CommitMessageGenerator"

const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: string[]) {
	await execFileAsync("git", args, { cwd })
}

describe("commit message generation flow", () => {
	const defaultConfig: ProviderSettings = { apiProvider: "openai", openAiApiKey: "default-key" }
	const providerSettingsManager = {
		initialize: vi.fn(),
		getProfile: vi.fn(),
	}
	const contextProxy = {
		isInitialized: true,
		getProviderSettings: vi.fn(() => defaultConfig),
		getValue: vi.fn((key: string) => {
			switch (key) {
				case "listApiConfigMeta":
					return []
				case "customSupportPrompts":
					return {}
				default:
					return undefined
			}
		}),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("passes collected git context with untracked file diff to the LLM", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-commit-generation-"))
		try {
			await runGit(tempRoot, ["init"])
			const filePath = path.join(tempRoot, "src", "new.ts")
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, "export const value = 1\n")

			const gitContext = await new GitContextCollector(tempRoot).collect({
				staged: false,
				includeBranch: false,
				recentCommits: { include: false },
			})
			const completePrompt = vi.fn().mockResolvedValue("feat(src): add new module")
			const generator = new CommitMessageGenerator(providerSettingsManager as any, {
				getContextProxy: () => contextProxy,
				completePrompt,
				addCustomInstructions: vi.fn().mockResolvedValue(""),
				captureGenerated: vi.fn(),
			})

			const message = await generator.generateMessage({
				workspacePath: tempRoot,
				selectedFiles: gitContext.changes.map((change) => change.filePath),
				gitContext: gitContext.context,
			})

			expect(message).toBe("feat(src): add new module")
			expect(gitContext.context).toContain("diff --git a/src/new.ts b/src/new.ts")
			expect(gitContext.context).toContain("+export const value = 1")
			expect(completePrompt).toHaveBeenCalledWith(
				defaultConfig,
				expect.stringContaining("+export const value = 1"),
			)
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})
})
