import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage, type HookDefinition } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilAborted, waitUntilCompleted } from "./utils"

const FIXTURE_SOURCE = `
const fs = require("fs")
const { spawn } = require("child_process")

const [mode, outputPath] = process.argv.slice(2)
const invocation = JSON.parse(fs.readFileSync(process.env.ZOO_CODE_HOOK_INVOCATION_FILE, "utf8"))

if (mode === "session") {
	fs.appendFileSync(outputPath, JSON.stringify(invocation) + "\\n")
	process.stdout.write("HOOK_SESSION_CONTEXT_MARKER\\n")
} else if (mode === "block") {
	fs.appendFileSync(outputPath, JSON.stringify(invocation) + "\\n")
	process.exit(2)
} else if (mode === "wait") {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
	fs.writeFileSync(outputPath, JSON.stringify({ rootPid: process.pid, childPid: child.pid, invocation }))
	setInterval(() => {}, 1000)
}
`

function isProcessAlive(pid: number) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

suite("Hooks MVP real-host smoke", function () {
	setDefaultSuiteTimeout(this)

	const api = globalThis.api
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	assert.ok(workspacePath, "The E2E harness must provide a workspace")

	const fixturePath = path.join(workspacePath, "hooks-e2e-fixture.cjs")
	const invocationLogPath = path.join(workspacePath, "hooks-e2e-invocations.jsonl")
	const cancellationPath = path.join(workspacePath, "hooks-e2e-cancellation.json")
	const blockTargetPath = path.join(workspacePath, "hooks-block-target.txt")
	const nodeExecutable = process.env.npm_node_execpath ?? process.execPath

	const definition = (
		values: Pick<HookDefinition, "id" | "name" | "phase"> &
			Partial<Pick<Extract<HookDefinition, { phase: "preToolUse" }>, "toolMatcher">> & {
				mode: string
				output: string
			},
	): HookDefinition =>
		({
			id: values.id,
			name: values.name,
			enabled: true,
			phase: values.phase,
			executable: nodeExecutable,
			argv: [fixturePath, values.mode, values.output],
			...(values.phase === "preToolUse" && { toolMatcher: values.toolMatcher }),
		}) as HookDefinition

	suiteSetup(async () => {
		await fs.writeFile(fixturePath, FIXTURE_SOURCE)
		await fs.writeFile(blockTargetPath, "This content must not be read.")
	})

	setup(async () => {
		await api.cancelCurrentTask().catch(() => undefined)
		await api.clearCurrentTask().catch(() => undefined)
		await api.setConfiguration({ hookDefinitions: [] })
		await Promise.all([fs.rm(invocationLogPath, { force: true }), fs.rm(cancellationPath, { force: true })])
	})

	teardown(async () => {
		await api.cancelCurrentTask().catch(() => undefined)
		await api.clearCurrentTask().catch(() => undefined)
		await api.setConfiguration({ hookDefinitions: [] })
	})

	suiteTeardown(async () => {
		await Promise.all([
			fs.rm(fixturePath, { force: true }),
			fs.rm(invocationLogPath, { force: true }),
			fs.rm(cancellationPath, { force: true }),
			fs.rm(blockTargetPath, { force: true }),
		])
	})

	test("runs sessionStart, sends output to the model, persists settings, and reopens history", async () => {
		const hook = definition({
			id: "e2e-session-start",
			name: "E2E session context",
			phase: "sessionStart",
			mode: "session",
			output: invocationLogPath,
		})
		await api.setConfiguration({ hookDefinitions: [hook] })

		const messages: ClineMessage[] = []
		const onMessage = ({ message }: { message: ClineMessage }) => messages.push(message)
		api.on(RooCodeEventName.Message, onMessage)
		try {
			const taskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: { mode: "ask", autoApprovalEnabled: true },
						text: "HOOKS_SESSION_START_E2E",
					}),
			})

			const hookMessage = messages.find(
				(message) =>
					message.say === "hook" && message.hook?.hookId === hook.id && message.hook.status === "succeeded",
			)
			assert.deepStrictEqual(
				hookMessage?.hook && {
					phase: hookMessage.hook.phase,
					status: hookMessage.hook.status,
					outputSummary: hookMessage.hook.outputSummary?.trim(),
				},
				{ phase: "sessionStart", status: "succeeded", outputSummary: "HOOK_SESSION_CONTEXT_MARKER" },
			)
			assert.ok(
				messages.some(
					(message) =>
						message.say === "completion_result" &&
						message.text?.includes("session hook context reached the model"),
				),
				"aimock should only complete after receiving the hook context",
			)

			const invocations = (await fs.readFile(invocationLogPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			assert.strictEqual(invocations.length, 1)
			assert.deepStrictEqual(
				{
					phase: invocations[0].phase,
					taskId: invocations[0].taskId,
					workspacePath: invocations[0].workspacePath,
				},
				{ phase: "sessionStart", taskId, workspacePath },
			)
			assert.deepStrictEqual(api.getConfiguration().hookDefinitions, [hook])
			assert.strictEqual(await api.isTaskInHistory(taskId), true)

			await api.clearCurrentTask()
			await api.resumeTask(taskId)
			await waitFor(() => api.getCurrentTaskStack().includes(taskId))
			await sleep(250)
			assert.deepStrictEqual(api.getConfiguration().hookDefinitions, [hook])
			assert.strictEqual((await fs.readFile(invocationLogPath, "utf8")).trim().split("\n").length, 1)
		} finally {
			api.off(RooCodeEventName.Message, onMessage)
		}
	})

	test("blocks a matching tool before execution and reports the decision to the model", async () => {
		const hook = definition({
			id: "e2e-pre-tool-block",
			name: "E2E read blocker",
			phase: "preToolUse",
			toolMatcher: ["read_file"],
			mode: "block",
			output: invocationLogPath,
		})
		await api.setConfiguration({ hookDefinitions: [hook] })

		const messages: ClineMessage[] = []
		const onMessage = ({ message }: { message: ClineMessage }) => messages.push(message)
		api.on(RooCodeEventName.Message, onMessage)
		try {
			const taskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: { mode: "code", autoApprovalEnabled: true, alwaysAllowReadOnly: true },
						text: "HOOKS_PRE_TOOL_BLOCK_E2E",
					}),
			})

			const hookMessage = messages.find(
				(message) =>
					message.say === "hook" && message.hook?.hookId === hook.id && message.hook.status === "blocked",
			)
			assert.deepStrictEqual(
				hookMessage?.hook && {
					phase: hookMessage.hook.phase,
					status: hookMessage.hook.status,
					matchedTool: hookMessage.hook.matchedTool,
				},
				{ phase: "preToolUse", status: "blocked", matchedTool: "read_file" },
			)
			assert.ok(
				messages.some(
					(message) =>
						message.say === "completion_result" && message.text?.includes("hook blocked read_file"),
				),
				"aimock should only complete after receiving the hook's blocking tool result",
			)

			const invocation = JSON.parse((await fs.readFile(invocationLogPath, "utf8")).trim())
			assert.deepStrictEqual(
				{ phase: invocation.phase, taskId: invocation.taskId, tool: invocation.tool },
				{ phase: "preToolUse", taskId, tool: { name: "read_file" } },
			)
		} finally {
			api.off(RooCodeEventName.Message, onMessage)
		}
	})

	test("cancels a running hook and terminates its process tree", async () => {
		const hook = definition({
			id: "e2e-session-cancel",
			name: "E2E cancellable hook",
			phase: "sessionStart",
			mode: "wait",
			output: cancellationPath,
		})
		await api.setConfiguration({ hookDefinitions: [hook] })

		const messages: ClineMessage[] = []
		const onMessage = ({ message }: { message: ClineMessage }) => messages.push(message)
		api.on(RooCodeEventName.Message, onMessage)
		try {
			const taskId = await api.startNewTask({
				configuration: { mode: "ask", autoApprovalEnabled: true },
				text: "HOOKS_CANCELLATION_E2E",
			})
			await waitFor(
				async () =>
					messages.some(
						(message) =>
							message.say === "hook" &&
							message.hook?.hookId === hook.id &&
							message.hook.status === "running",
					) &&
					(await fs.stat(cancellationPath).then(
						() => true,
						() => false,
					)),
			)

			const processInfo = JSON.parse(await fs.readFile(cancellationPath, "utf8"))
			const aborted = waitUntilAborted({ api, taskId })
			await api.cancelCurrentTask()
			await aborted
			await waitFor(() => !isProcessAlive(processInfo.rootPid) && !isProcessAlive(processInfo.childPid))

			const hookMessage = messages.find(
				(message) =>
					message.say === "hook" && message.hook?.hookId === hook.id && message.hook.status === "cancelled",
			)
			assert.ok(hookMessage, "The persisted hook row should transition from running to cancelled")
			assert.deepStrictEqual(
				{ phase: processInfo.invocation.phase, taskId: processInfo.invocation.taskId },
				{ phase: "sessionStart", taskId },
			)
		} finally {
			api.off(RooCodeEventName.Message, onMessage)
		}
	})
})
