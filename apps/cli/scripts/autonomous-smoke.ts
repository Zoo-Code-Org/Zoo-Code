import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

import { execa } from "execa"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliEntry = path.resolve(__dirname, "../dist/index.js")
const extensionPath = path.resolve(__dirname, "../../../src/dist")

type ToolCall = { name: string; arguments: Record<string, unknown>; id: string }

function sendTool(response: ServerResponse, call: ToolCall): void {
	response.writeHead(200, { "content-type": "text/event-stream" })
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-autonomous-smoke",
			object: "chat.completion.chunk",
			created: 1,
			model: "smoke-model",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: call.id,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							},
						],
					},
					finish_reason: null,
				},
			],
		})}\n\n`,
	)
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-autonomous-smoke",
			object: "chat.completion.chunk",
			created: 1,
			model: "smoke-model",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}\n\n`,
	)
	response.end("data: [DONE]\n\n")
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "zoo-autonomous-smoke-"))
	const workspace = path.join(root, "workspace")
	const home = path.join(root, "home")
	const globalSettings = path.join(home, ".vscode-mock", "global-storage", "settings")

	try {
		await mkdir(path.join(workspace, ".roo", "rules-orchestrator"), { recursive: true })
		await mkdir(path.join(home, ".roo", "rules"), { recursive: true })
		await mkdir(globalSettings, { recursive: true })
		await writeFile(
			path.join(workspace, ".roomodes"),
			"customModes:\n  - slug: orchestrator\n    name: Project Orchestrator\n    roleDefinition: PROJECT_ORCHESTRATOR_OVERRIDE\n    groups: []\n",
		)
		await writeFile(path.join(workspace, ".roo", "rules-orchestrator", "project.md"), "PROJECT_MODE_RULE")
		await writeFile(path.join(workspace, "AGENTS.md"), "PROJECT_AGENTS_INSTRUCTION")
		await writeFile(path.join(home, ".roo", "rules", "global.md"), "GLOBAL_PORTABLE_RULE")
		await writeFile(
			path.join(globalSettings, "custom_modes.yaml"),
			"customModes:\n  - slug: orchestrator\n    name: Global Orchestrator\n    roleDefinition: GLOBAL_ORCHESTRATOR_SHOULD_LOSE\n    groups: []\n",
		)

		const requestCounts = {
			delegationInitial: 0,
			delegationChild: 0,
			delegationResume: 0,
			modeInitial: 0,
			modeAfterSwitch: 0,
		}
		const observedHangs = new Map<string, () => void>()
		const server = createServer(async (request, response) => {
			if (!request.url?.endsWith("/chat/completions")) {
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ data: [] }))
				return
			}

			const body = await readBody(request)
			if (body.includes("PROCESS_QUESTION_SMOKE")) {
				sendTool(response, {
					name: "ask_followup_question",
					arguments: { question: "Human decision required", follow_up: [] },
					id: "call_smoke_question",
				})
				return
			}
			if (body.includes("PROCESS_PROVIDER_FAILURE_SMOKE")) {
				response.writeHead(401, { "content-type": "application/json" })
				response.end(JSON.stringify({ error: { message: "intentional provider failure" } }))
				return
			}
			for (const marker of [
				"PROCESS_TIMEOUT_SMOKE",
				"PROCESS_CANCELLATION_SMOKE",
				"PROCESS_FORCE_CANCELLATION_SMOKE",
			]) {
				if (body.includes(marker)) {
					observedHangs.get(marker)?.()
					return
				}
			}
			if (body.includes("PROCESS_MODE_SWITCH_SMOKE")) {
				if (body.includes("call_smoke_mode_complete")) {
					response.writeHead(409)
					response.end("duplicate request after accepted mode completion")
					return
				}
				if (!body.includes("call_smoke_switch_mode")) {
					requestCounts.modeInitial++
					sendTool(response, {
						name: "switch_mode",
						arguments: { mode_slug: "ask", reason: "process smoke" },
						id: "call_smoke_switch_mode",
					})
					return
				}
				requestCounts.modeAfterSwitch++
				sendTool(response, {
					name: "attempt_completion",
					arguments: { result: "SMOKE_MODE_SWITCH_RESULT" },
					id: "call_smoke_mode_complete",
				})
				return
			}
			if (body.includes("SMOKE_CHILD_CONTEXT") && !body.includes("PROCESS_DELEGATION_SMOKE")) {
				requestCounts.delegationChild++
				sendTool(response, {
					name: "attempt_completion",
					arguments: { result: "SMOKE_CHILD_RESULT" },
					id: "call_smoke_child_complete",
				})
				return
			}
			if (body.includes("PROCESS_DELEGATION_SMOKE") && body.includes("call_smoke_root_complete")) {
				response.writeHead(409)
				response.end("duplicate request after accepted root completion")
				return
			}
			if (body.includes("PROCESS_DELEGATION_SMOKE") && body.includes("SMOKE_CHILD_RESULT")) {
				requestCounts.delegationResume++
				sendTool(response, {
					name: "attempt_completion",
					arguments: { result: "SMOKE_ROOT_RESULT" },
					id: "call_smoke_root_complete",
				})
				return
			}
			if (body.includes("PROCESS_DELEGATION_SMOKE")) {
				requestCounts.delegationInitial++
				for (const marker of [
					"PROJECT_ORCHESTRATOR_OVERRIDE",
					"PROJECT_MODE_RULE",
					"PROJECT_AGENTS_INSTRUCTION",
					"GLOBAL_PORTABLE_RULE",
				]) {
					if (!body.includes(marker)) throw new Error(`provider request did not include ${marker}`)
				}
				if (body.includes("GLOBAL_ORCHESTRATOR_SHOULD_LOSE")) {
					throw new Error("project orchestrator did not override the global mode")
				}
				sendTool(response, {
					name: "new_task",
					arguments: { mode: "code", message: "SMOKE_CHILD_CONTEXT: complete immediately" },
					id: "call_smoke_delegate",
				})
				return
			}

			response.writeHead(404)
			response.end("no deterministic fixture matched")
		})

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("failed to bind fake provider")
		const commonArgs = [
			cliEntry,
			"--autonomous",
			"--print",
			"--workspace",
			workspace,
			"--extension",
			extensionPath,
			"--provider",
			"openrouter",
			"--provider-base-url",
			`http://127.0.0.1:${address.port}/v1`,
			"--api-key",
			"not-a-secret",
			"--model",
			"smoke-model",
			"--output-format",
			"stream-json",
		]
		const runScenario = (prompt: string, timeoutSeconds: string) =>
			execa(process.execPath, [...commonArgs, "--timeout", timeoutSeconds, prompt], {
				env: { HOME: home },
				reject: false,
				timeout: 30_000,
			})
		const terminalEvents = (stdout: string) =>
			stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((event) => event.type === "result" && event.subtype === "terminal")
		const assertTerminal = (result: Awaited<ReturnType<typeof runScenario>>, state: string, exitCode: number) => {
			const terminals = terminalEvents(result.stdout)
			if (result.exitCode !== exitCode || terminals.length !== 1 || terminals[0]?.state !== state) {
				throw new Error(
					`expected ${state}/${exitCode}: actual=${result.exitCode} signal=${result.signal} stderr=${result.stderr} stdout=${result.stdout}`,
				)
			}
			if (state !== "configuration_error" && typeof terminals[0]?.rootTaskId !== "string") {
				throw new Error(`terminal outcome did not include rootTaskId: ${result.stdout}`)
			}
			return terminals[0]!
		}

		const result = await runScenario("PROCESS_DELEGATION_SMOKE", "20")
		const completed = assertTerminal(result, "completed", 0)
		if (
			requestCounts.delegationInitial !== 1 ||
			requestCounts.delegationChild !== 1 ||
			requestCounts.delegationResume !== 1
		) {
			throw new Error(`unexpected delegation sequence: ${JSON.stringify(requestCounts)}`)
		}
		if (completed.content !== "SMOKE_ROOT_RESULT") throw new Error("child completion exited the root run")
		const rootTaskId = completed.rootTaskId as string
		const tasksPath = path.join(home, ".vscode-mock", "global-storage", "tasks")
		const rootHistory = JSON.parse(
			await readFile(path.join(tasksPath, rootTaskId, "history_item.json"), "utf8"),
		) as Record<string, unknown>
		let childTaskId: string | undefined
		let childHistory: Record<string, unknown> | undefined
		for (const taskId of await readdir(tasksPath)) {
			const history = JSON.parse(
				await readFile(path.join(tasksPath, taskId, "history_item.json"), "utf8"),
			) as Record<string, unknown>
			if (history.parentTaskId === rootTaskId) {
				childTaskId = taskId
				childHistory = history
				break
			}
		}
		if (
			!childTaskId ||
			!childHistory ||
			rootHistory.status !== "completed" ||
			rootHistory.mode !== "orchestrator" ||
			childHistory.status !== "completed" ||
			childHistory.mode !== "code" ||
			childHistory.parentTaskId !== rootTaskId
		) {
			throw new Error(`invalid persisted lineage: ${JSON.stringify({ rootHistory, childHistory })}`)
		}
		const modeSwitched = assertTerminal(await runScenario("PROCESS_MODE_SWITCH_SMOKE", "20"), "completed", 0)
		if (
			requestCounts.modeInitial !== 1 ||
			requestCounts.modeAfterSwitch !== 1 ||
			modeSwitched.content !== "SMOKE_MODE_SWITCH_RESULT"
		) {
			throw new Error("switch_mode did not preserve the root task conversation")
		}
		const invalidMode = await execa(
			process.execPath,
			[...commonArgs, "--timeout", "20", "--mode", "code", "PROCESS_INVALID_MODE_SMOKE"],
			{ env: { HOME: home }, reject: false, timeout: 30_000 },
		)
		assertTerminal(invalidMode, "configuration_error", 78)

		assertTerminal(await runScenario("PROCESS_QUESTION_SMOKE", "20"), "needs_input", 2)
		assertTerminal(await runScenario("PROCESS_PROVIDER_FAILURE_SMOKE", "20"), "provider_failed", 4)

		let timeoutObserved!: () => void
		const timeoutRequest = new Promise<void>((resolve) => {
			timeoutObserved = resolve
		})
		observedHangs.set("PROCESS_TIMEOUT_SMOKE", timeoutObserved)
		const timeoutRun = runScenario("PROCESS_TIMEOUT_SMOKE", "0.1")
		await timeoutRequest
		assertTerminal(await timeoutRun, "timed_out", 124)

		let cancellationObserved!: () => void
		const cancellationRequest = new Promise<void>((resolve) => {
			cancellationObserved = resolve
		})
		observedHangs.set("PROCESS_CANCELLATION_SMOKE", cancellationObserved)
		const cancellationRun = runScenario("PROCESS_CANCELLATION_SMOKE", "20")
		let cancellationOutput = ""
		const cancellationReady = new Promise<void>((resolve) => {
			cancellationRun.stdout?.on("data", (chunk) => {
				cancellationOutput += chunk.toString()
				if (cancellationOutput.includes('"type":"system","subtype":"init"')) resolve()
			})
		})
		await Promise.all([cancellationReady, cancellationRequest])
		if (!cancellationRun.pid) throw new Error("cancellation smoke process has no pid")
		process.kill(cancellationRun.pid, "SIGINT")
		assertTerminal(await cancellationRun, "cancelled", 130)

		let forceCancellationObserved!: () => void
		const forceCancellationRequest = new Promise<void>((resolve) => {
			forceCancellationObserved = resolve
		})
		observedHangs.set("PROCESS_FORCE_CANCELLATION_SMOKE", forceCancellationObserved)
		const forceCancellationRun = runScenario("PROCESS_FORCE_CANCELLATION_SMOKE", "20")
		await forceCancellationRequest
		if (!forceCancellationRun.pid) throw new Error("force-cancellation smoke process has no pid")
		process.kill(forceCancellationRun.pid, "SIGINT")
		process.kill(forceCancellationRun.pid, "SIGINT")
		const forceResult = await forceCancellationRun
		if (forceResult.signal !== "SIGINT") throw new Error("second SIGINT did not force process termination")

		server.close()
		process.stdout.write("autonomous process smoke passed\n")
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

await main()
