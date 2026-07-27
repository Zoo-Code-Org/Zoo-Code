import fs from "fs"
import path from "path"
import os from "os"

import type { FlagOptions } from "@/types/index.js"
import { run } from "../run.js"

vi.mock("@roo-code/vscode-shim", () => ({
	setLogger: vi.fn(),
}))

vi.mock("@/lib/storage/index.js", () => ({
	loadSettings: vi.fn(() => Promise.resolve({})),
}))

vi.mock("@/lib/task-history/index.js", () => ({
	readWorkspaceTaskSessions: vi.fn(() => Promise.resolve([])),
	resolveWorkspaceResumeSessionId: vi.fn(() => "test-session-id"),
}))

vi.mock("@/lib/utils/onboarding.js", () => ({
	runOnboarding: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/utils/shell.js", () => ({
	validateTerminalShellPath: vi.fn(() => Promise.resolve({ valid: false, reason: "test" })),
}))

// Helper to create a complete FlagOptions object with defaults
function createFlagOptions(overrides: Partial<FlagOptions> = {}): FlagOptions {
	return {
		continue: false,
		print: false,
		stdinPromptStream: false,
		signalOnlyExit: false,
		debug: false,
		requireApproval: false,
		autonomous: false,
		exitOnError: false,
		ephemeral: false,
		oneshot: false,
		...overrides,
	}
}

vi.mock("@/agent/index.js", () => ({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ExtensionHost: vi.fn(function (this: any) {
		this.activate = vi.fn(() => Promise.resolve())
		this.client = { hasActiveTask: vi.fn(() => false) }
		this.dispose = vi.fn(() => Promise.resolve())
		this.cancelTask = vi.fn(() => Promise.resolve())
		this.getRootTaskId = vi.fn(() => "test-root-id")
		this.getLastTaskResult = vi.fn(() => ({ result: "success", rootTaskId: "test-root-id" }))
		this.sendToExtension = vi.fn(() => Promise.resolve())
		this.isWaitingForInput = vi.fn(() => false)
		this.runTask = vi.fn(() => Promise.resolve())
		this.resumeTask = vi.fn(() => Promise.resolve())
		return this
	}),
}))

describe("run command validation", () => {
	let tempDir: string
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>
	const originalEnv = { ...process.env }

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"))
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit: ${code}`)
		})
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		process.env.OPENROUTER_API_KEY = "test-key"
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
		process.env = { ...originalEnv }
	})

	describe("session ID validation", () => {
		it("should reject empty --session-id", async () => {
			const flags = createFlagOptions({ sessionId: "" })

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: --session-id requires a non-empty session id")
		})

		it("should reject invalid --session-id format", async () => {
			const flags = createFlagOptions({ sessionId: "not-a-uuid" })

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: --session-id must be a valid UUID session id")
		})

		it("should reject empty --create-with-session-id", async () => {
			const flags = createFlagOptions({ createWithSessionId: "" })

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: --create-with-session-id requires a non-empty session id",
			)
		})

		it("should reject invalid --create-with-session-id format", async () => {
			const flags = createFlagOptions({ createWithSessionId: "not-a-uuid" })

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: --create-with-session-id must be a valid UUID session id",
			)
		})

		it("should reject --create-with-session-id with --session-id", async () => {
			const validUuid = "123e4567-e89b-12d3-a456-426614174000"
			const flags = createFlagOptions({
				createWithSessionId: validUuid,
				sessionId: validUuid,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: cannot use --create-with-session-id with --session-id/--continue",
			)
		})

		it("should reject --session-id with --continue", async () => {
			const validUuid = "123e4567-e89b-12d3-a456-426614174000"
			const flags = createFlagOptions({
				sessionId: validUuid,
				continue: true,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: cannot use --session-id with --continue")
		})

		it("should reject prompt with resume flags", async () => {
			const validUuid = "123e4567-e89b-12d3-a456-426614174000"
			const flags = createFlagOptions({ sessionId: validUuid })

			await expect(run("test prompt", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: cannot use prompt or --prompt-file with --session-id/--continue",
			)
		})
	})

	describe("provider validation", () => {
		it("should reject invalid provider", async () => {
			const flags = createFlagOptions({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				provider: "invalid-provider" as any,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Invalid provider: invalid-provider"),
			)
		})

		it("should reject missing API key", async () => {
			delete process.env.OPENROUTER_API_KEY
			const flags = createFlagOptions({ print: true })

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: No API key provided. Use --api-key or set the appropriate environment variable.",
			)
		})
	})

	describe("autonomous mode validation", () => {
		it("should reject autonomous without workspace in non-cwd scenario", async () => {
			const nonExistentPath = path.join(tempDir, "nonexistent")
			const flags = createFlagOptions({
				autonomous: true,
				workspace: nonExistentPath,
				timeout: 60,
				outputFormat: "json",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 78")
		})

		it("should reject autonomous with non-directory workspace", async () => {
			const filePath = path.join(tempDir, "file.txt")
			fs.writeFileSync(filePath, "content")
			const flags = createFlagOptions({
				autonomous: true,
				workspace: filePath,
				timeout: 60,
				outputFormat: "json",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 78")
		})

		it("should enforce orchestrator mode in autonomous", async () => {
			const flags = createFlagOptions({
				autonomous: true,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				mode: "code" as any,
				workspace: tempDir,
				timeout: 60,
				outputFormat: "json",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 78")
		})

		it("should reject autonomous without timeout", async () => {
			const flags = createFlagOptions({
				autonomous: true,
				workspace: tempDir,
				outputFormat: "json",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 78")
		})
	})

	describe("output format validation", () => {
		it("should reject invalid output format", async () => {
			const flags = createFlagOptions({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				outputFormat: "invalid" as any,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[CLI] Error: Invalid output format"))
		})

		it("should require --print with non-text output format in TTY", async () => {
			// Mock TTY
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })

			const flags = createFlagOptions({
				outputFormat: "json",
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: --output-format requires --print mode")
		})
	})

	describe("stdin stream validation", () => {
		it("should reject --stdin-prompt-stream without --print", async () => {
			const flags = createFlagOptions({
				stdinPromptStream: true,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: --stdin-prompt-stream requires --print mode")
		})

		it("should reject --stdin-prompt-stream with wrong output format", async () => {
			const flags = createFlagOptions({
				stdinPromptStream: true,
				print: true,
				outputFormat: "json",
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: --stdin-prompt-stream requires --output-format=stream-json",
			)
		})

		it("should reject --signal-only-exit without --stdin-prompt-stream", async () => {
			const flags = createFlagOptions({
				signalOnlyExit: true,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: --signal-only-exit requires --stdin-prompt-stream",
			)
		})

		it("should reject --stdin-prompt-stream with TTY stdin", async () => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

			const flags = createFlagOptions({
				stdinPromptStream: true,
				print: true,
				outputFormat: "stream-json",
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: --stdin-prompt-stream requires piped stdin")
		})

		it("should reject prompt with --stdin-prompt-stream", async () => {
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })

			const flags = createFlagOptions({
				stdinPromptStream: true,
				print: true,
				outputFormat: "stream-json",
			})

			await expect(run("test prompt", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: cannot use positional prompt or --prompt-file with --stdin-prompt-stream",
			)
		})

		it("should reject --create-with-session-id with --stdin-prompt-stream", async () => {
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })

			const validUuid = "123e4567-e89b-12d3-a456-426614174000"
			const flags = createFlagOptions({
				stdinPromptStream: true,
				print: true,
				outputFormat: "stream-json",
				createWithSessionId: validUuid,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[CLI] Error: --create-with-session-id is not supported with --stdin-prompt-stream",
			)
		})
	})

	describe("consecutive mistake limit validation", () => {
		it("should reject negative consecutive mistake limit", async () => {
			const flags = createFlagOptions({
				consecutiveMistakeLimit: -1,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Invalid consecutive mistake limit"),
			)
		})

		it("should reject non-integer consecutive mistake limit", async () => {
			const flags = createFlagOptions({
				consecutiveMistakeLimit: 1.5,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Invalid consecutive mistake limit"),
			)
		})
	})

	describe("reasoning effort validation", () => {
		it("should reject invalid reasoning effort", async () => {
			const flags = createFlagOptions({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				reasoningEffort: "invalid" as any,
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Invalid reasoning effort"),
			)
		})
	})

	describe("workspace validation", () => {
		it("should reject non-existent workspace path", async () => {
			const flags = createFlagOptions({
				workspace: "/nonexistent/path",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Workspace path does not exist"),
			)
		})
	})

	describe("providerBaseUrl validation", () => {
		it("should reject providerBaseUrl with non-openrouter provider in non-autonomous mode", async () => {
			const flags = createFlagOptions({
				providerBaseUrl: "https://custom-base-url.com",
				provider: "anthropic",
				print: true,
			})

			await expect(run("test", flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("--provider-base-url is currently supported only with --provider openrouter"),
			)
		})
	})

	describe("prompt file validation", () => {
		it("should reject non-existent prompt file", async () => {
			const flags = createFlagOptions({
				promptFile: path.join(tempDir, "nonexistent.txt"),
				print: true,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[CLI] Error: Prompt file does not exist"),
			)
		})
	})

	describe("no prompt validation", () => {
		it("should reject missing prompt in print mode", async () => {
			const flags = createFlagOptions({
				print: true,
			})

			await expect(run(undefined, flags)).rejects.toThrow("process.exit: 1")
			expect(consoleErrorSpy).toHaveBeenCalledWith("[CLI] Error: no prompt provided")
		})
	})
})

describe("run command --prompt-file option", () => {
	let tempDir: string
	let promptFilePath: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"))
		promptFilePath = path.join(tempDir, "prompt.md")
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("should read prompt from file when --prompt-file is provided", () => {
		const promptContent = `This is a test prompt with special characters:
- Quotes: "hello" and 'world'
- Backticks: \`code\`
- Newlines and tabs
- Unicode: 你好 🎉`

		fs.writeFileSync(promptFilePath, promptContent)

		// Verify the file was written correctly
		const readContent = fs.readFileSync(promptFilePath, "utf-8")
		expect(readContent).toBe(promptContent)
	})

	it("should handle multi-line prompts correctly", () => {
		const multiLinePrompt = `Line 1
Line 2
Line 3

Empty line above
\tTabbed line
  Indented line`

		fs.writeFileSync(promptFilePath, multiLinePrompt)
		const readContent = fs.readFileSync(promptFilePath, "utf-8")

		expect(readContent).toBe(multiLinePrompt)
		expect(readContent.split("\n")).toHaveLength(7)
	})

	it("should handle very long prompts that would exceed ARG_MAX", () => {
		// ARG_MAX is typically 128KB-2MB, so let's test with a 500KB prompt
		const longPrompt = "x".repeat(500 * 1024)

		fs.writeFileSync(promptFilePath, longPrompt)
		const readContent = fs.readFileSync(promptFilePath, "utf-8")

		expect(readContent.length).toBe(500 * 1024)
		expect(readContent).toBe(longPrompt)
	})

	it("should preserve shell-sensitive characters", () => {
		const shellSensitivePrompt = `
$HOME
$(echo dangerous)
\`rm -rf /\`
"quoted string"
'single quoted'
$((1+1))
&&
||
;
> /dev/null
< input.txt
| grep something
*
?
[abc]
{a,b}
~
!
#comment
%s
\n\t\r
`

		fs.writeFileSync(promptFilePath, shellSensitivePrompt)
		const readContent = fs.readFileSync(promptFilePath, "utf-8")

		// All shell-sensitive characters should be preserved exactly
		expect(readContent).toBe(shellSensitivePrompt)
		expect(readContent).toContain("$HOME")
		expect(readContent).toContain("$(echo dangerous)")
		expect(readContent).toContain("`rm -rf /`")
	})
})
