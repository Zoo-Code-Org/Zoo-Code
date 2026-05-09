import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"

import { runTests } from "@vscode/test-electron"
import { LLMock } from "@copilotkit/aimock"

async function main() {
	const isRecord = process.env.AIMOCK_RECORD === "true"

	if (isRecord && !process.env.OPENROUTER_API_KEY) {
		throw new Error("AIMOCK_RECORD=true requires OPENROUTER_API_KEY to record fixtures")
	}

	// Record mode always needs aimock running (to capture traffic).
	// Replay mode starts aimock when no real API key is present or USE_MOCK is forced.
	const useMock = isRecord || !process.env.OPENROUTER_API_KEY || process.env.USE_MOCK === "true"

	let mock: InstanceType<typeof LLMock> | undefined

	// The folder containing the Extension Manifest package.json
	// Passed to `--extensionDevelopmentPath`
	const extensionDevelopmentPath = path.resolve(__dirname, "../../../src")

	// The path to the extension test script
	// Passed to --extensionTestsPath
	const extensionTestsPath = path.resolve(__dirname, "./suite/index")

	let testWorkspace: string | undefined

	try {
		if (useMock) {
			const fixturesDir = path.resolve(__dirname, "../fixtures")

			mock = new LLMock({
				port: 0, // random free port
				...(isRecord && {
					record: {
						// OpenRouter is OpenAI-compatible; aimock proxies using the openai provider key.
						// Use /api (not /api/v1) — aimock appends the request path (/v1/chat/completions)
						// so including /v1 here would produce a doubled /v1/v1 upstream URL.
						providers: { openai: "https://openrouter.ai/api" },
						fixturePath: fixturesDir,
					},
				}),
			})

			mock.loadFixtureDir(fixturesDir)

			if (!isRecord) {
				// The modes test (switch_mode → ask) triggers a second API call whose last
				// user message starts with <environment_details> directly — no <user_message>
				// wrapper. JSON fixtures use substring matching so a bare "<environment_details>"
				// match would collide with all other requests. A regex anchored to the start
				// uniquely identifies this post-switch turn.
				mock.addFixture({
					match: { userMessage: /^<environment_details>/ },
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

		// Create a temporary workspace folder for tests
		testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-workspace-"))
		// Get test filter from command line arguments or environment variable
		// Usage examples:
		// - npm run test:e2e -- --grep "write-to-file"
		// - TEST_GREP="apply-diff" npm run test:e2e
		// - TEST_FILE="task.test.js" npm run test:e2e
		const testGrep = process.argv.find((arg, i) => process.argv[i - 1] === "--grep") || process.env.TEST_GREP
		const testFile = process.argv.find((arg, i) => process.argv[i - 1] === "--file") || process.env.TEST_FILE

		// Pass test filters and mock URL as environment variables to the test runner
		const extensionTestsEnv = {
			...process.env,
			...(testGrep && { TEST_GREP: testGrep }),
			...(testFile && { TEST_FILE: testFile }),
			...(mock && { AIMOCK_URL: mock.url }),
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
