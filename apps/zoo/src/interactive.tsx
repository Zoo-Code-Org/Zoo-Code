import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Box, Text, render, useInput } from "ink"
import { useState } from "react"

import { exitCodeFor, type ZooRunResult } from "@roo-code/zoo-protocol"

import { runOverrides, type SharedOptions } from "./options.js"
import { initialProjection, reduceSession, type SessionProjection } from "./projection.js"
import { defaultStorageRoot, HostClient } from "./supervisor.js"

type InteractiveOptions = Omit<SharedOptions, "cwd" | "timeout"> & { workspace: string }

type Actions = {
	submit: (text: string) => void
	approve: (approve: boolean) => void
	cancel: () => void
	exit: () => void
}

export function InteractiveSession({ projection, actions }: { projection: SessionProjection; actions: Actions }) {
	const [input, setInput] = useState("")
	const ask = [...projection.pendingAsks.entries()][0]

	useInput((value, key) => {
		if (key.ctrl && value === "c") return actions.cancel()
		if (key.ctrl && value === "d" && input.length === 0) return actions.exit()
		if (ask && (value.toLowerCase() === "y" || value.toLowerCase() === "n")) {
			actions.approve(value.toLowerCase() === "y")
			return
		}
		if (key.return) {
			if (input.trim()) actions.submit(input.trim())
			setInput("")
			return
		}
		if (key.backspace || key.delete) return setInput((current) => current.slice(0, -1))
		if (!key.ctrl && !key.meta && value) setInput((current) => current + value)
	})

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
				<Text bold color="cyan">
					Zoo Code
				</Text>
				<Text>{projection.rootTaskId ? `session ${projection.rootTaskId}` : "ready"}</Text>
			</Box>
			{[...projection.messages.entries()].map(([id, message]) => (
				<Box key={id} marginTop={1} flexDirection="column">
					<Text color={message.role === "reasoning" ? "gray" : "white"}>{message.role}</Text>
					<Text wrap="wrap">{message.content}</Text>
				</Box>
			))}
			{[...projection.tools.entries()].map(([id, tool]) => (
				<Box
					key={id}
					borderStyle="single"
					borderColor={tool.state === "failed" ? "red" : "yellow"}
					paddingX={1}>
					<Text>{`${tool.name} · ${tool.state}${tool.output ? ` · ${tool.output}` : ""}`}</Text>
				</Box>
			))}
			{ask ? (
				<Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
					<Text bold>Approval required</Text>
					<Text>{ask[1].subject}</Text>
					<Text color="gray">Press y to approve once or n to reject</Text>
				</Box>
			) : null}
			{projection.result ? (
				<Text color={projection.result.success ? "green" : "red"}>{projection.result.outcome}</Text>
			) : null}
			<Box marginTop={1}>
				<Text color="cyan">› </Text>
				<Text>{input}</Text>
			</Box>
			<Text color="gray">Enter sends · Ctrl+C cancels · Ctrl+D exits when idle</Text>
		</Box>
	)
}

export async function runInteractive(initialPrompt: string | undefined, options: InteractiveOptions): Promise<number> {
	const storageRoot = options.ephemeral
		? fs.mkdtempSync(path.join(os.tmpdir(), "zoo-"))
		: path.join(defaultStorageRoot(), "state")
	fs.mkdirSync(storageRoot, { recursive: true })
	let projection = initialProjection()
	let update: ((projection: SessionProjection) => void) | undefined
	let rootTaskId: string | undefined
	let currentTaskId: string | undefined
	let settle: ((result: ZooRunResult | undefined) => void) | undefined
	const settled = new Promise<ZooRunResult | undefined>((resolve) => (settle = resolve))
	const client = new HostClient({
		workspace: options.workspace,
		storageRoot,
		extensionRoot: process.env.ZOO_EXTENSION_PATH ?? fileURLToPath(new URL("../../../src/dist", import.meta.url)),
		debug: options.debug,
		onEvent(event) {
			projection = reduceSession(projection, event)
			currentTaskId = projection.currentTaskId
			update?.(projection)
			if (event.type === "task.result") settle?.(event.result)
		},
	})

	await client.start()
	let starting = false
	const actions: Actions = {
		submit(text) {
			if (!rootTaskId && !starting) {
				starting = true
				void client
					.command({
						type: "task.start",
						workspace: options.workspace,
						prompt: text,
						overrides: runOverrides({ ...options, approval: "interactive" }),
					})
					.then((response) => {
						if (response.data.commandType === "task.start") rootTaskId = response.data.task.rootTaskId
					})
					.catch(() => settle?.(undefined))
				return
			}
			if (currentTaskId) void client.command({ type: "task.input", taskId: currentTaskId, text })
		},
		approve(approve) {
			const pending = [...projection.pendingAsks.entries()][0]
			if (!pending) return
			void client.command({
				type: "ask.respond",
				taskId: pending[1].taskId,
				askId: pending[0],
				response: approve ? "approve" : "reject",
			})
		},
		cancel() {
			if (rootTaskId) void client.command({ type: "task.cancel", rootTaskId, reason: "user" })
			else settle?.(undefined)
		},
		exit: () => settle?.(undefined),
	}
	const App = () => {
		const [state, setState] = useState(projection)
		update = setState
		return <InteractiveSession projection={state} actions={actions} />
	}
	const instance = render(<App />, { exitOnCtrlC: false })
	if (initialPrompt) actions.submit(initialPrompt)
	const result = await settled
	instance.unmount()
	await client.stop()
	if (options.ephemeral) fs.rmSync(storageRoot, { recursive: true, force: true })
	if (!result) return 0
	const failedCode =
		result.error?.code === "task_timed_out" || result.error?.code === "cleanup_timed_out"
			? "task_failed"
			: (result.error?.code ?? "task_failed")
	return exitCodeFor(
		result.outcome === "failed"
			? { outcome: "failed", errorCode: failedCode }
			: result.outcome === "cancelled"
				? { outcome: "cancelled" }
				: result.outcome === "timed_out"
					? { outcome: "timed_out" }
					: { outcome: result.outcome },
	)
}
