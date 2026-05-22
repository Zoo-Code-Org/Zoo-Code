import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"

import { runTests } from "@vscode/test-electron"
import { LLMock } from "@copilotkit/aimock"

import { addApplyDiffResultFixtures } from "./fixtures/apply-diff"
import { addExecuteCommandResultFixtures } from "./fixtures/execute-command"
import { addListFilesResultFixtures } from "./fixtures/list-files"
import { addReadFileResultFixtures } from "./fixtures/read-file"
import { addSearchFilesResultFixtures } from "./fixtures/search-files"
import { addUseMcpToolResultFixtures } from "./fixtures/use-mcp-tool"
import { addWriteToFileResultFixtures } from "./fixtures/write-to-file"

function getCliFlagValue(flag: string) {
	return process.argv.find((arg, index) => process.argv[index - 1] === flag)
}

function isDeepSeekTargetedRun(testFile?: string, testGrep?: string) {
	if (testFile?.toLowerCase().includes("deepseek-v4.test")) {
		return true
	}

	// DeepSeek grep runs may target the suite name, file stem, or individual model IDs.
	return testGrep?.toLowerCase().includes("deepseek") ?? false
}

async function main() {
	const isRecord = process.env.AIMOCK_RECORD === "true"
	const testGrep = getCliFlagValue("--grep") || process.env.TEST_GREP
	const testFile = getCliFlagValue("--file") || process.env.TEST_FILE
	const isDeepSeekTest = isDeepSeekTargetedRun(testFile, testGrep)
	const isGeminiTest = testFile?.toLowerCase().includes("gemini.test") ?? false

	if (isRecord && isDeepSeekTest && !process.env.DEEPSEEK_API_KEY) {
		throw new Error("AIMOCK_RECORD=true requires DEEPSEEK_API_KEY to record DeepSeek fixtures")
	}

	if (isRecord && isGeminiTest && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
		throw new Error("AIMOCK_RECORD=true requires GEMINI_API_KEY to record Gemini fixtures")
	}

	if (isRecord && !isDeepSeekTest && !isGeminiTest && !process.env.OPENROUTER_API_KEY) {
		throw new Error("AIMOCK_RECORD=true requires OPENROUTER_API_KEY to record fixtures")
	}

	// Record mode always needs aimock running (to capture traffic).
	// Replay mode starts aimock when no real API key is present or USE_MOCK is forced.
	const hasRealApiKey = isDeepSeekTest
		? !!process.env.DEEPSEEK_API_KEY
		: !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY)
	const useMock = isRecord || !hasRealApiKey || process.env.USE_MOCK === "true"

	let mock: InstanceType<typeof LLMock> | undefined

	// The folder containing the Extension Manifest package.json
	// Passed to `--extensionDevelopmentPath`
	const extensionDevelopmentPath = path.resolve(__dirname, "../../../src")

	// The path to the extension test script
	// Passed to --extensionTestsPath
	const extensionTestsPath = path.resolve(__dirname, "./suite/index")

	let testWorkspace: string | undefined

	try {
		// Create a temporary workspace folder for tests before installing fixtures that
		// need workspace-specific paths.
		testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-workspace-"))

		if (useMock) {
			const fixturesDir = path.resolve(__dirname, "../fixtures")

			mock = new LLMock({
				port: 0, // random free port
				...(isRecord && {
					record: {
						// OpenRouter is OpenAI-compatible; aimock proxies using the openai provider key.
						// Use /api (not /api/v1) — aimock appends the request path (/v1/chat/completions)
						// so including /v1 here would produce a doubled /v1/v1 upstream URL.
						providers: {
							openai: isDeepSeekTest ? "https://api.deepseek.com" : "https://openrouter.ai/api",
							// aimock forwards the x-api-key header from the Anthropic SDK to the real API.
							anthropic: "https://api.anthropic.com",
							// aimock forwards the x-goog-api-key header from the Google AI SDK.
							...(isGeminiTest && { gemini: "https://generativelanguage.googleapis.com" }),
						},
						fixturePath: fixturesDir,
					},
				}),
			})

			mock.loadFixtureDir(fixturesDir)

			if (!isRecord) {
				addApplyDiffResultFixtures(mock)
				addExecuteCommandResultFixtures(mock)
				addListFilesResultFixtures(mock)
				addReadFileResultFixtures(mock)
				addSearchFilesResultFixtures(mock)
				addUseMcpToolResultFixtures(mock)
				addWriteToFileResultFixtures(mock)

				// The modes test (switch_mode → ask) triggers a second API call whose last
				// user message starts with <environment_details> directly — no <user_message>
				// wrapper. JSON fixtures use substring matching so a bare "<environment_details>"
				// match would collide with all other requests. A regex anchored to the start
				// uniquely identifies this post-switch turn. Scope this fixture to the
				// OpenRouter default model so provider-specific suites (e.g. DeepSeek)
				// cannot accidentally match it.
				mock.addFixture({
					match: { model: "openai/gpt-4.1", userMessage: /^<environment_details>/ },
					response: {
						toolCalls: [
							{
								name: "attempt_completion",
								arguments: JSON.stringify({ result: "Switched to ❓ Ask mode as requested." }),
								id: "call_modes_post_switch_001",
							},
						],
					},
				})
			}

			await mock.start()
		}
		// Get test filter from command line arguments or environment variable
		// Usage examples:
		// - npm run test:e2e -- --grep "write-to-file"
		// - TEST_GREP="apply-diff" npm run test:e2e
		// - TEST_FILE="task.test.js" npm run test:e2e

		// Pass test filters and mock URL as environment variables to the test runner
		const extensionTestsEnv = {
			...process.env,
			...(testGrep && { TEST_GREP: testGrep }),
			...(testFile && { TEST_FILE: testFile }),
			...(mock && { AIMOCK_URL: mock.url }),
			...(mock && { E2E_MOCK_MODEL_LIST_FALLBACK: "true" }),
		}

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [testWorkspace],
			extensionTestsEnv,
			version: process.env.VSCODE_VERSION || "1.101.2",
		})
	} catch (error) {
		console.error("Failed to run tests", error)
		process.exitCode = 1
	} finally {
		if (testWorkspace) {
			await fs.rm(testWorkspace, { recursive: true, force: true })
		}
		await mock?.stop()
	}
}

main()
