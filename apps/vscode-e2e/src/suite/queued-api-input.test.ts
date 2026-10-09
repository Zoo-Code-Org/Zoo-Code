import { providerIdentifiers } from "@roo-code/types"
import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage, type QueuedMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor } from "./utils"
import {
	QUEUED_API_INPUT_MARKER_FILE,
	QUEUED_API_INPUT_MESSAGE,
	QUEUED_API_INPUT_PROMPT,
} from "../fixtures/queued-api-input"

suite("Roo Code queued API input", function () {
	setDefaultSuiteTimeout(this)

	let markerPath: string

	suiteSetup(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		await globalThis.api.setConfiguration({
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: aimockUrl ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "anthropic/claude-sonnet-4.5",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
		markerPath = path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, QUEUED_API_INPUT_MARKER_FILE)
	})

	teardown(async () => {
		await fs.rm(markerPath, { force: true })
		while (globalThis.api.getCurrentTaskStack().length > 0) {
			await globalThis.api.clearCurrentTask()
		}
	})

	test("queued API input does not approve a protected command ask", async () => {
		const api = globalThis.api
		await fs.rm(markerPath, { force: true })

		let queue: QueuedMessage[] = []
		let commandAsk: ClineMessage | undefined
		let interactive = false

		const onQueue = (_taskId: string, messages: QueuedMessage[]) => {
			if (messages.length > 0) queue = messages
		}
		const onMessage = ({ message }: { message: ClineMessage }) => {
			if (message.type === "ask" && message.ask === "command" && message.partial !== true) {
				commandAsk = message
			}
		}
		const onInteractive = () => {
			interactive = true
		}

		api.on(RooCodeEventName.QueuedMessagesUpdated, onQueue)
		api.on(RooCodeEventName.Message, onMessage)
		api.on(RooCodeEventName.TaskInteractive, onInteractive)

		try {
			const taskId = await api.startNewTask({
				configuration: { mode: "code", autoApprovalEnabled: false, enableCheckpoints: false },
				text: QUEUED_API_INPUT_PROMPT,
			})

			// Wait until the first request reaches the mock. The mock then delays its
			// response, so the task is still streaming when the API input arrives.
			await waitFor(async () => {
				const response = await fetch(`${process.env.AIMOCK_URL}/__aimock/journal`)
				return JSON.stringify(await response.json()).includes(QUEUED_API_INPUT_PROMPT)
			})
			await api.sendMessage(QUEUED_API_INPUT_MESSAGE)

			await waitFor(() => commandAsk !== undefined)
			await waitFor(() => interactive)
			await sleep(1_500)

			assert.ok(queue.some((m) => m.text === QUEUED_API_INPUT_MESSAGE && m.origin === "api"))
			await assert.rejects(fs.access(markerPath), "Queued API input must not run the command")
			assert.strictEqual(api.getCurrentTaskStack().at(-1), taskId)

			await api.approveCurrentAsk()
			await waitFor(() =>
				fs.access(markerPath).then(
					() => true,
					() => false,
				),
			)
		} finally {
			api.off(RooCodeEventName.QueuedMessagesUpdated, onQueue)
			api.off(RooCodeEventName.Message, onMessage)
			api.off(RooCodeEventName.TaskInteractive, onInteractive)
		}
	})
})
