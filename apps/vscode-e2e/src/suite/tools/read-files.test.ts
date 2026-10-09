import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import * as vscode from "vscode"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"
import { waitFor } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

suite("Zoo Code native batch reading", function () {
	setDefaultSuiteTimeout(this)

	test("returns slice and structural reads in one native tool result", async () => {
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace, "Expected the test workspace")
		const slicePath = path.join(workspace, "batch-read-slice.txt")
		const blockPath = path.join(workspace, "batch-read-block.ts")
		await fs.writeFile(slicePath, "first\nsecond")
		await fs.writeFile(blockPath, "function greet() {\n    return 'hello'\n}")
		const api = globalThis.api
		const messages: ClineMessage[] = []
		const onMessage = ({ message }: { message: ClineMessage }) => messages.push(message)
		api.on(RooCodeEventName.Message, onMessage)
		try {
			await api.clearCurrentTask()
			await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
				},
				text: "NATIVE_READ_FILES_BATCH_SMOKE: Read the two known files in one native batch call using independent slice and structural parameters.",
			})
			await waitFor(
				() =>
					messages.some(
						(message) =>
							message.say === "completion_result" && message.text?.includes("NATIVE_READ_FILES_BATCH_OK"),
					),
				{ timeout: 60_000 },
			)
			assert.ok(
				messages.some(
					(message) => message.say === "completion_result" && message.text?.includes("second and hello"),
				),
				"The mock only completes after a single batch tool result contains both file reads",
			)
			assert.deepEqual(
				messages.filter((message) => message.say === "error").map((message) => message.text),
				[],
			)
		} finally {
			api.off(RooCodeEventName.Message, onMessage)
			await api.clearCurrentTask()
			await fs.rm(slicePath, { force: true })
			await fs.rm(blockPath, { force: true })
		}
	})
})
