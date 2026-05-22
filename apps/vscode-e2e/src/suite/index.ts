import * as path from "path"
import Mocha from "mocha"
import { glob } from "glob"
import * as vscode from "vscode"

import type { RooCodeAPI, RooCodeEventName } from "@roo-code/types"

import { waitFor } from "./utils"

export async function run() {
	const extension = vscode.extensions.getExtension<RooCodeAPI>("RooVeterinaryInc.roo-cline")

	if (!extension) {
		throw new Error("Extension not found")
	}

	const api = extension.isActive ? extension.exports : await extension.activate()

	const aimockUrl = process.env.AIMOCK_URL
	const isRecord = process.env.AIMOCK_RECORD === "true"

	await api.setConfiguration({
		apiProvider: "openrouter" as const,
		// In record mode, forward the real key so aimock can proxy it to OpenRouter.
		// In replay mode, "mock-key" is sufficient — aimock never contacts the real API.
		openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
		openRouterModelId: "openai/gpt-4.1",
		...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
	})

	await vscode.commands.executeCommand("roo-cline.SidebarProvider.focus")
	await waitFor(() => api.isReady())

	// Automatically approve completion_result asks so tests don't stall waiting
	// for a button that the webview routes to "start new task" rather than "yes".
	api.on("message" as RooCodeEventName.Message, ({ message }) => {
		if (message.type === "ask" && message.ask === "completion_result") {
			api.approveCurrentAsk()
		}
	})

	globalThis.api = api

	const mochaOptions: Mocha.MochaOptions = {
		ui: "tdd",
		timeout: 20 * 60 * 1_000, // 20m
	}

	if (process.env.TEST_GREP) {
		mochaOptions.grep = process.env.TEST_GREP
		console.log(`Running tests matching pattern: ${process.env.TEST_GREP}`)
	}

	const mocha = new Mocha(mochaOptions)
	const cwd = path.resolve(__dirname, "..")

	let testFiles: string[]

	if (process.env.TEST_FILE) {
		const specificFile = process.env.TEST_FILE.endsWith(".js")
			? process.env.TEST_FILE
			: `${process.env.TEST_FILE}.js`

		testFiles = await glob(`**/${specificFile}`, { cwd })
		console.log(`Running specific test file: ${specificFile}`)
	} else {
		testFiles = await glob("**/**.test.js", { cwd })
	}

	if (testFiles.length === 0) {
		throw new Error(`No test files found matching criteria: ${process.env.TEST_FILE || "all tests"}`)
	}

	testFiles.forEach((testFile) => mocha.addFile(path.resolve(cwd, testFile)))

	return new Promise<void>((resolve, reject) =>
		mocha.run((failures) => (failures === 0 ? resolve() : reject(new Error(`${failures} tests failed.`)))),
	)
}
